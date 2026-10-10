#!/usr/bin/env node
/**
 * Regenerate the compaction override for every preset in ../cordis.patch.yml.
 *
 * dsh-app-boot's applyEntryPatches only descends entries marked `group: true`, and
 * the top-level `preset-*` entries are not groups: their `config` is a map holding a
 * `plugins` array, so `Array.isArray(entry.config)` is false and their children are
 * never indexed. `- id: compaction-basic` therefore resolves to the disabled
 * top-level row from dsh-web-app, not to the copy a preset actually mounts. Each
 * preset also mounts its compaction service under `isolate: { compaction: true }`, so
 * that inner copy is the one agents use.
 *
 * The only supported override point is the preset entry itself, whose `config` is
 * replaced wholesale. That means carrying copies of upstream's presets, so this
 * script rebuilds them from the tree dsh itself composes rather than from
 * hand-edited snapshots. Re-run it after any upstream DSH upgrade:
 *
 *   node scripts/regenerate-preset-compaction-override.mjs
 *
 * Set DSH_HOME to compose a different preview tree than apps/web/.test-runtime.
 *
 * It rewrites only the block between the BEGIN/END markers.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webRoot = join(repoRoot, 'apps/web');
const patchFile = join(repoRoot, 'packages/bundle/cordis.patch.yml');
const BEGIN = '# BEGIN generated preset compaction override';
const END = '# END generated preset compaction override';
// The block was originally generated for preset-standard alone; drop that block too
// so widening the marker does not leave a stale copy of the same presets behind.
const LEGACY_BEGIN = '# BEGIN generated preset-standard compaction override';
const LEGACY_END = '# END generated preset-standard compaction override';

const dshHome = process.env.DSH_HOME ?? join(webRoot, '.test-runtime/preview');

const dump = execFileSync(
  process.execPath,
  [join(webRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'preview', '--dump-config'],
  { cwd: webRoot, env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const lines = dump.split('\n');

// Every preset that mounts dsh-compaction-basic needs the override. `preset-minimal`
// mounts none, so it needs nothing: upstream defaults would be unreachable there.
const COMPACTION_PRESETS = ['preset-standard', 'preset-ptc', 'preset-cordis'];

/**
 * Copy one top-level preset entry out of the composed tree, ready to be re-emitted
 * as a patch that replaces it wholesale.
 */
function extractPresetBlock(presetId) {
  const start = lines.findIndex((line) => line.trimEnd() === `- id: ${presetId}`);
  if (start < 0) throw new Error(`${presetId} is absent from the composed tree`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ') || lines[i].startsWith('# ==')) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const configAt = block.findIndex((line) => line.startsWith('  config:'));
  if (configAt < 0) throw new Error(`${presetId} has no config to copy`);
  return ['- id: ' + presetId, ...block.slice(configAt)];
}

/**
 * Give every compaction-basic inside `override` an explicit config, so the engine
 * that agents actually mount never falls back to the upstream headroomTokens=65536.
 * Entries that already carry a config are left untouched.
 */
function applyCompactionConfig(override, presetId) {
  const out = [];
  let found = 0;
  for (let i = 0; i < override.length; i += 1) {
    const line = override[i];
    out.push(line);
    if (line.trim() !== '- id: compaction-basic') continue;
    // Key order under this entry is not fixed: upstream presets may author it
    // name-then-config, and our own previous run emits config-then-name. Read
    // the whole entry rather than assuming offsets, or a second run reads back
    // what the first wrote and throws.
    const entryIndent = line.length - line.trimStart().length;
    let nameLine;
    let hasConfig = false;
    for (let j = i + 1; j < override.length; j += 1) {
      const sibling = override[j];
      if (sibling.trim() === '') continue;
      const indent = sibling.length - sibling.trimStart().length;
      if (indent <= entryIndent) break;
      if (nameLine === undefined && sibling.trimStart().startsWith('name:')) nameLine = sibling;
      if (sibling.trim() === 'config:') hasConfig = true;
    }
    if (nameLine === undefined || !nameLine.includes('dsh-compaction-basic')) {
      throw new Error(`compaction-basic in ${presetId} has no name: sibling`);
    }
    found += 1;
    // Already carries a config: this tree was composed with our own patch applied,
    // which is the idempotent case, not an upstream change.
    if (hasConfig) continue;
    const indent = ' '.repeat(nameLine.length - nameLine.trimStart().length);
    out.push(`${indent}config:`, `${indent}  headroomTokens: 8192`, `${indent}  maxTokens: 4096`);
  }
  if (found === 0) throw new Error(`${presetId} no longer mounts compaction-basic; upstream layout changed`);
  return out;
}

const override = COMPACTION_PRESETS.flatMap((presetId) =>
  applyCompactionConfig(extractPresetBlock(presetId), presetId),
);

/** Drop any previously generated block, whichever marker spelling wrote it. */
function stripGenerated(text) {
  for (const marker of [BEGIN, LEGACY_BEGIN]) {
    const from = text.indexOf(marker);
    if (from >= 0) return text.slice(0, from).trimEnd();
  }
  return text.trimEnd();
}

const head = stripGenerated(readFileSync(patchFile, 'utf8'));
writeFileSync(patchFile, `${head}\n\n${BEGIN}\n${override.join('\n')}\n${END}\n`);
process.stdout.write(`regenerated compaction override for ${COMPACTION_PRESETS.length} presets: ${override.length} lines\n`);