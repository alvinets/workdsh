# workdsh-plugin-tool-gates

Live enable/disable tool families (computer-use, browser-tools) per agent.

## Purpose

The `cua_driver_native__*` family (59 tools, ~23K tokens) and the browser MCP family (24 tools, ~4.3K tokens) together consume nearly half the tool budget. This plugin lets the Settings UI toggle both families on or off at runtime. Changes take effect on the next agent step and persist across sessions; no process restart is required.

## Usage

```bash
# From the Settings UI → 高级工具 section
# Toggle computerUse or browserTools; state persists across sessions.
```

## Architecture

- **Server**: `ToolGatesManager` service registered as `workdshToolGates`; exposes `POST /api/workdsh-tool-gates` with `get`/`set` endpoints.
- **Client**: Settings section `workdsh-tool-gates` (order 19) with two `role="switch"` toggles.
- **Storage**: Domain `workdsh_tool_gates`, table `settings`, row `global`.
- **Computer use**: On `agent/created` and for every agent in `ctx.agents.list()`, masked with `agent.ctx.tools.restrict({ deny: exactNames })`. Disposers are stored per agent and family so enabling one family never un-restricts the other.
- **Browser tools**: delegated to `workdshBrowserSession.setToolsEnabled(agent, enabled)`, which mounts or unmounts the Playwright MCP client. `restrict()` is not used here because session-scoped MCP tools are not inherited global tools.
- **Availability**: `computerUse` reflects registered `cua_driver_native__*` schemas; `browserTools` reflects the presence of the browser-session provider.
