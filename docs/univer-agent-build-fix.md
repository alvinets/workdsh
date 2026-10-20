# Univer Agent Build Failure: Root Cause and Future Fix

- **Status:** Proposed
- **Date:** 2026-10-20
- **Area:** WorkDSH agent tools / `dsh-univer-office` / `dsh-tool-fs`
- **Priority:** P0 (recovery), P1 (workflow enforcement)
- **Non-goal:** changing the Univer renderer, compiler, or `.univer` format

## Summary

WorkDSH can build a Univer deck. The failed run was not an Univer rendering
failure; it was an agent/tool-contract failure that produced a deterministic
retry loop:

1. The agent tried to edit `spec.md` and `page-01.svg` without a successful
   prior `read`. The file-observation policy rejected the edit with
   `FS_NOT_OBSERVED`.
2. The agent's reads targeted directories (`/`, `/home`) instead of regular
   files. `dsh-tool-fs` rejected them with `not a regular file`, so no
   observation was recorded and the edits stayed blocked.
3. The `.univer` container already existed. The agent retried `univer_new`,
   which is intentionally create-only, so the gateway returned
   `univerfile already exists`.
4. The generic `GATEWAY_REQUEST_FAILED` wrapper made the existing-file error
   look like a transport failure, encouraging another retry instead of
   `univer_status`.

The same `.univer` container was later used successfully to build a 6-page,
960x540 deck with clean lint and a valid 6-slide PPTX. The fix is therefore in
the agent-facing tool behavior and recovery guidance, not in Univer itself.

## Observed Errors

```text
Error: cannot modify "<...>/spec.md": file has not been read — read the file, then retry
Error: cannot modify "<...>/page-01.svg": file has not been read — read the file, then retry
Error: cannot read "/": not a regular file
Error: cannot read "/home": not a regular file
Error [GATEWAY_REQUEST_FAILED]: univerfile already exists: <...>/dsh-intro.univer
```

The `file has not been read` message is the model-facing normalization of the
`FS_NOT_OBSERVED` policy error. It is not a missing-file error.

## Root Causes

### 1. Read-before-write guard is working as designed

Relevant packages:

- `@deepseek-ai/dsh-fs-observation-policy`
- `@deepseek-ai/dsh-tool-fs`

Behavior:

- `edit` requires a prior successful `read` of the exact target.
- `write` creates new files, but refuses to overwrite an existing file that
  the session has not read.
- A failed read does **not** create an observation.
- A resumed session starts with no observed state and must re-read files.

Relevant documentation:

- `node_modules/@deepseek-ai/dsh-fs-observation-policy/README.md`
  - "edit requires reading `<path>` first"
  - "A session resumes with no observed state, so it must re-read files before
    guarded mutations succeed again."
- `node_modules/@deepseek-ai/dsh-tool-fs/README.md`
  - `FS_NOT_OBSERVED` is normalized to
    `cannot modify "<path>": file has not been read — read the file, then retry`
  - `cannot read "<path>": not a regular file` is the stable directory/non-file
    error
  - paths must be absolute

This guard must not be weakened. The fix is to make the recovery path obvious,
not to allow unobserved edits.

### 2. The agent used `read` as a directory lister

`read` accepts regular files only. It is not an `ls` replacement. The error
paths `/` and `/home` show the calls were probing parent directories rather
than reading the target files. Because those calls failed, the observation
policy never recorded `spec.md` or `page-01.svg`, so every subsequent edit was
rejected.

The workspace is deep:

```text
<repo>/apps/web/.test-runtime/preview/workdsh-projects/<project-hash>/
```

Relative paths are refused, and guessing parent directories is not useful.
The correct discovery path is `bash ls`, `glob`, or another directory-listing
operation, followed by `read` with the exact absolute file path.

### 3. `univer_new` is create-only, not open-or-create

`univer_new` is intentionally described as:

> Create a new empty `.univer` file in the current workspace. This never
> overwrites an existing file and does not create an implicit Unit.

Implementation path:

```text
src/host/tools/definitions/new.ts
  -> ctx.univer.newFile(...)
  -> GatewayFileApi.create(file)
  -> POST /uf/<base64url(file)>
  -> gateway prepareNewUniverfilePath()
  -> UniverfileExistsError("univerfile already exists: <path>")
```

The container already existed, so no amount of retrying `univer_new` could
succeed. The correct branch is:

- Existing `.univer` -> `univer_status`
- New `.univer` -> `univer_new`, then `univer_worktree` create
- Existing draft worktree -> continue it
- New deck content -> `univer_unit` create, then `univer_compile_svg`

The bundled `univer` skill already states this:

```text
skills/univer/SKILL.md
  Existing `.univer`: call `univer_status` before selecting a Unit or worktree.
  New `.univer`: call `univer_new`, then `univer_worktree` with `action: "create"`.
```

The failed run did not follow that existing-file branch.

### 4. Business-state errors are mislabeled as gateway failures

`univerfile already exists` is a deterministic business-state error. Wrapping
it as `GATEWAY_REQUEST_FAILED` makes it look retryable and hides the recovery
instruction. The model retried create instead of switching to `univer_status`.

This is the highest-value error-classification fix.

## Reproduction Evidence

The same container was used through the bundled
`GatewayUniverService` from the preview profile:

```text
status()             -> worktree wt-...-y6pace, two empty slide units
unit({ action: "remove" }) -> removed duplicate unit
compileSvg(page 1..6) -> 960x540, no warnings, no lints
lintUnitLayout()     -> findings: []
screenshotUnit()     -> 6 PNGs at 1920x1080
exportUnitContent()  -> PPTX
```

Result:

- 1 slide unit
- 6 pages
- draft head revision 13
- 0 compile warnings
- 0 layout-lint findings
- 6-slide PPTX at 960x540 pt

This proves the failure is not in the Univer format, compiler, or exporter.

## Proposed Fix

### P0: Make `univer_new` recoverable

Preferred behavior:

```ts
univer_new({
  file,
  ifExists?: "error" | "reuse"   // default: "error"
})
```

- `ifExists: "error"` preserves current safety and returns a structured
  `FILE_EXISTS` result:
  ```json
  {
    "ok": false,
    "code": "FILE_EXISTS",
    "file": "<path>",
    "next": {
      "tool": "univer_status",
      "arguments": { "file": "<path>" }
    }
  }
  ```
- `ifExists: "reuse"` calls the status path and returns the existing trunk and
  worktrees instead of creating.
- Do not make the gateway overwrite. Keep `prepareNewUniverfilePath` as the
  last line of defense.
- Map gateway `UniverfileExistsError` to `FILE_EXISTS`; reserve
  `GATEWAY_REQUEST_FAILED` for transport/HTTP failures.

Optional alternative: add a separate `univer_open` tool that is an alias for
the status read path. `univer_status` already provides the needed data, so this
is optional.

### P0: Make directory reads self-correcting

In `dsh-tool-fs` error normalization:

```text
cannot read "<path>": path is a directory; use `bash ls` or `glob` to list it,
then `read` a regular file.
```

Requirements:

- Preserve a stable structured code such as `EISDIR` or
  `FS_NOT_REGULAR_FILE`.
- Keep the existing behavior that a failed read does not satisfy the
  observation policy.
- Optionally add a `list_directory` tool. The existing `bash`/`glob` tools are
  sufficient if the error hint is clear.
- Update the `read` tool description to explicitly say "regular files only; use
  `bash ls`/`glob` for directories."

Do not make `read` accept directories. That would blur the observation policy
and make text reads unpredictable.

### P1: Enforce the Univer workflow

Choose one or more:

1. **Auto-load the skills**
   - When a task references `.univer`, `.pptx`, `.xlsx`, `.docx`, Base, or
     Board, load `univer` first and the matching Unit skill second.
   - The current skill catalog is present but not enforced by the tool.

2. **Preflight in `univer_new`**
   - If the file exists, return `FILE_EXISTS` with `next: univer_status`.
   - If it does not exist, create it and return `next: univer_worktree`.

3. **Deterministic deck builder**
   - Add a higher-level tool or agent preset:
     ```text
     build_deck({
       file, worktreeName, unitName, specPath, svgDir, exportPath
     })
     ```
   - It performs status-or-create, draft worktree, slide unit, page 1 compile,
     append pages, lint each page, screenshot, and export.
   - This removes path and sequencing decisions from the model for the common
     case.

A deterministic builder is the most robust fix for weak tool-use models. The
skill/auto-load fix is cheaper and improves all Univer tasks.

### P1: Preserve business error semantics

Add a gateway error envelope mapping:

| Gateway condition | Tool code | Recovery |
|---|---|---|
| `univerfile already exists` | `FILE_EXISTS` | call `univer_status` |
| worktree not draft | `WORKTREE_NOT_DRAFT` | inspect with `univer_status` |
| unit not found | `UNIT_NOT_FOUND` | list units with `univer_status` |
| gateway unavailable | `GATEWAY_UNAVAILABLE` | retry status once |
| HTTP/transport failure | `GATEWAY_REQUEST_FAILED` | retry with backoff |

The model should not have to parse a free-form message to distinguish these.

### P2: Model and prompt guidance

- Use a stronger tool-use model for multi-step Office/Univer tasks.
- Add a short system-prompt rule:
  - `read` is for regular files, not directories.
  - `univer_new` is create-only; use `univer_status` for existing files.
  - Read a file successfully before editing it.
- Add evaluation cases that replay the failed transcript and assert recovery.

## Tests

### Unit tests

- `univer_new` on an existing file returns `FILE_EXISTS` and does not call
  create.
- `univer_new` on a missing file creates exactly one container.
- `univer_new({ ifExists: "reuse" })` returns existing status and does not
  overwrite.
- `read("/")` returns the directory hint and does not record an observation.
- `edit` before `read` still returns `FS_NOT_OBSERVED`.
- `edit` after a successful `read` succeeds.
- Gateway `UniverfileExistsError` maps to `FILE_EXISTS`, not
  `GATEWAY_REQUEST_FAILED`.

### Integration test

1. Create a `.univer` container.
2. Call `univer_new` again; assert recovery.
3. Call `univer_status`; create a draft worktree.
4. Create a slide unit.
5. Compile page 1.
6. Append pages 2..6 using `pageCount + 1`.
7. Lint every page; assert no findings.
8. Screenshot all pages.
9. Export PPTX; assert 6 slides and 960x540.
10. Run the flow twice; assert no duplicate units and no data loss.

### Acceptance criteria

- The failed transcript's first recovery step is `univer_status`, not a second
  `univer_new`.
- A directory `read` produces an actionable hint instead of a dead end.
- Existing `.univer` files are never overwritten by `univer_new`.
- The 6-page deck builds end-to-end without direct service calls.
- `GATEWAY_REQUEST_FAILED` is reserved for transport failures.

## Implementation Notes

The affected packages are external DSH dependencies, not WorkDSH application
code:

- `dsh-univer-office`: tool definitions, `newFile`, gateway client, and
  `prepareNewUniverfilePath`.
- `dsh-tool-fs`: read error normalization and tool description.
- `dsh-fs-observation-policy`: keep the existing observation semantics; do not
  weaken them.

Implementation options, in order of preference:

1. Fix upstream in DSH and bump the pinned package.
2. Add a WorkDSH plugin/adapter that wraps `univer_new` and the `read` error
   presentation.
3. Add a WorkDSH patch under `patches/` if an upstream release is not
   available.
4. As a stopgap, update the agent preset/system prompt and auto-load the
   Univer skills; this does not fix the API semantics but avoids the loop.

Do not add an overwrite mode to the gateway. `univer_new` must remain
non-destructive; recovery belongs in the tool wrapper.

## Non-Goals

- Do not change the `.univer` SQLite format.
- Do not bypass the read-before-edit policy.
- Do not make `read` list directories.
- Do not merge the draft worktree automatically.
- Do not silently overwrite an existing `.univer`.

## Open Questions

1. Should `univer_new` return `FILE_EXISTS` or should the tool provide a
   separate `univer_open`?
2. Should the directory hint be implemented in `dsh-tool-fs` upstream, or in a
   WorkDSH wrapper?
3. Should the deterministic deck builder be a tool, an agent preset, or both?
4. Which model should be required for multi-step Univer tasks?

## References

- `node_modules/@deepseek-ai/dsh-tool-fs/README.md`
- `node_modules/@deepseek-ai/dsh-fs-observation-policy/README.md`
- `node_modules/dsh-univer-office/lib/index.js`
  - `newFile`
  - `GatewayFileApi.create`
  - `univer_new` tool definition
  - `univer_status` tool definition
- `node_modules/dsh-univer-office/artifacts/gateway.cjs`
  - `prepareNewUniverfilePath`
  - `UniverfileExistsError`
- `node_modules/dsh-univer-office/skills/univer/SKILL.md`
- `node_modules/dsh-univer-office/skills/univer-slide/SKILL.md`
