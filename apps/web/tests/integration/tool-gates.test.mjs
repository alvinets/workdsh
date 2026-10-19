import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolGatesManager } from '../../../../packages/plugins/tool-gates/dist/index.js';

function registerTool(ctx, name) {
  ctx.tools.register({
    name,
    description: 'fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { return {}; },
  });
}

// Build a scoped tools proxy that delegates to the real tools but supports restrict()
function makeScopedTools(realTools, scopeKey) {
  const restrictions = new Set();
  const hidden = new Set();
  return new Proxy(realTools, {
    get(target, prop, receiver) {
      if (prop === 'restrict') {
        return (filter) => {
          if (filter.deny) filter.deny.forEach(n => restrictions.add(n));
          if (filter.allow) {
            // Remove all previously denied when allow is set
            restrictions.clear();
            filter.allow.forEach(n => restrictions.delete(n));
          }
          return () => { if (filter.deny) filter.deny.forEach(n => restrictions.delete(n)); if (filter.allow) filter.allow.forEach(n => restrictions.add(n)); };
        };
      }
      if (prop === 'schemas') {
        return () => {
          const all = target.schemas();
          return all.filter(s => !restrictions.has(s.name) && !hidden.has(s.name));
        };
      }
      if (prop === 'setHidden') {
        return (names) => { hidden.clear(); names.forEach(n => hidden.add(n)); };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Simulate the browser provider: mounted tools are hidden when disabled.
function provideBrowserSession(ctx, scopedTools, browserNames) {
  const calls = [];
  ctx.provide('workdshBrowserSession', {
    async setToolsEnabled(agent, enabled) {
      calls.push({ agentId: agent.id, enabled });
      scopedTools.setHidden(enabled ? [] : browserNames);
    },
  });
  return calls;
}

test('default-off applies deny mask with exact filtered names on agent/created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-gates-default-'));
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(Tools);

    registerTool(ctx, 'cua_driver_native__keyboard_press');
    registerTool(ctx, 'cua_driver_native__mouse_move');
    registerTool(ctx, 'mcp__playwright-mcp__navigate');
    registerTool(ctx, 'mcp__playwright-mcp__click');
    registerTool(ctx, 'regular_tool');

    const scopedTools = makeScopedTools(ctx.tools, 'agent-1');
    const agent = { id: 'agent-1', ctx: { tools: scopedTools } };
    const browserCalls = provideBrowserSession(ctx, scopedTools, ['mcp__playwright-mcp__navigate', 'mcp__playwright-mcp__click']);
    ctx.provide('agents', { list: () => [agent], get: () => agent });
    ctx.emit('agent/created', { agent });

    await ctx.plugin(ToolGatesManager);

    const { state, available } = await ctx.workdshToolGates.get();
    assert.equal(state.computerUse, false);
    assert.equal(state.browserTools, false);
    assert.equal(available.computerUse, true);
    assert.equal(available.browserTools, true);
    assert.equal(browserCalls.at(-1)?.enabled, false, 'browser provider should start disabled');

    const names = scopedTools.schemas().map(t => t.name);
    assert.ok(!names.includes('cua_driver_native__keyboard_press'), 'computer-use tool should be denied');
    assert.ok(!names.includes('cua_driver_native__mouse_move'), 'computer-use tool should be denied');
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'), 'browser tool should be denied');
    assert.ok(!names.includes('mcp__playwright-mcp__click'), 'browser tool should be denied');
    assert.ok(names.includes('regular_tool'), 'regular tool should still be available');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enabling a family disposes only that family restriction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-gates-enable-'));
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(Tools);

    registerTool(ctx, 'cua_driver_native__keyboard_press');
    registerTool(ctx, 'mcp__playwright-mcp__navigate');
    registerTool(ctx, 'regular_tool');

    const scopedTools = makeScopedTools(ctx.tools, 'agent-2');
    const agent = { id: 'agent-2', ctx: { tools: scopedTools } };
    const browserCalls = provideBrowserSession(ctx, scopedTools, ['mcp__playwright-mcp__navigate']);
    ctx.provide('agents', { list: () => [agent], get: () => agent });
    ctx.emit('agent/created', { agent });

    await ctx.plugin(ToolGatesManager);

    let names = scopedTools.schemas().map(t => t.name);
    assert.ok(!names.includes('cua_driver_native__keyboard_press'));
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'));
    assert.equal(browserCalls.at(-1)?.enabled, false);

    const state = await ctx.workdshToolGates.set({ computerUse: true });
    assert.equal(state.computerUse, true);
    assert.equal(state.browserTools, false);

    names = scopedTools.schemas().map(t => t.name);
    assert.ok(names.includes('cua_driver_native__keyboard_press'), 'computer-use tool should be available after enabling');
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'), 'browser tool should still be denied');
    assert.ok(names.includes('regular_tool'));
    assert.equal(browserCalls.at(-1)?.enabled, false, 'enabling computer use must not enable browser tools');

    await ctx.workdshToolGates.set({ browserTools: true });
    names = scopedTools.schemas().map(t => t.name);
    assert.ok(names.includes('mcp__playwright-mcp__navigate'), 'browser tool should be available after enabling');
    assert.equal(browserCalls.at(-1)?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty names for a family do not throw when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-gates-empty-'));
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(Tools);

    registerTool(ctx, 'regular_tool');
    registerTool(ctx, 'another_tool');

    const scopedTools = makeScopedTools(ctx.tools, 'agent-empty');
    const agent = { id: 'agent-empty', ctx: { tools: scopedTools } };
    ctx.provide('agents', { list: () => [agent], get: () => agent });
    ctx.emit('agent/created', { agent });

    await ctx.plugin(ToolGatesManager);

    const { state, available } = await ctx.workdshToolGates.get();
    assert.equal(state.computerUse, false);
    assert.equal(state.browserTools, false);
    assert.equal(available.computerUse, false);
    assert.equal(available.browserTools, false);

    const names = scopedTools.schemas().map(t => t.name);
    assert.ok(names.includes('regular_tool'));
    assert.ok(names.includes('another_tool'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('set persists state and re-applies to existing agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-gates-persist-'));
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(Tools);

    registerTool(ctx, 'cua_driver_native__keyboard_press');
    registerTool(ctx, 'mcp__playwright-mcp__navigate');

    const scopedTools = makeScopedTools(ctx.tools, 'agent-persist');
    const agent = { id: 'agent-persist', ctx: { tools: scopedTools } };
    const browserCalls = provideBrowserSession(ctx, scopedTools, ['mcp__playwright-mcp__navigate']);
    ctx.provide('agents', { list: () => [agent], get: () => agent });
    ctx.emit('agent/created', { agent });

    await ctx.plugin(ToolGatesManager);

    let names = scopedTools.schemas().map(t => t.name);
    assert.ok(!names.includes('cua_driver_native__keyboard_press'));
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'));
    assert.equal(browserCalls.at(-1)?.enabled, false);

    await ctx.workdshToolGates.set({ browserTools: true });
    names = scopedTools.schemas().map(t => t.name);
    assert.ok(!names.includes('cua_driver_native__keyboard_press'), 'computerUse should stay denied');
    assert.ok(names.includes('mcp__playwright-mcp__navigate'), 'browserTools should be available');
    assert.equal(browserCalls.at(-1)?.enabled, true);

    await ctx.workdshToolGates.set({ computerUse: true });
    names = scopedTools.schemas().map(t => t.name);
    assert.ok(names.includes('cua_driver_native__keyboard_press'), 'computerUse should now be available');
    assert.ok(names.includes('mcp__playwright-mcp__navigate'));
    assert.equal(browserCalls.at(-1)?.enabled, true);

    await ctx.workdshToolGates.set({ computerUse: false, browserTools: false });
    names = scopedTools.schemas().map(t => t.name);
    assert.ok(!names.includes('cua_driver_native__keyboard_press'));
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'));
    assert.equal(browserCalls.at(-1)?.enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new agents created after setting inherit the current gate state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-gates-new-agent-'));
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    ctx.provide('agents', { list: () => [], get: () => undefined });
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(Tools);

    registerTool(ctx, 'cua_driver_native__keyboard_press');
    registerTool(ctx, 'mcp__playwright-mcp__navigate');
    registerTool(ctx, 'regular_tool');

    await ctx.plugin(ToolGatesManager);

    // Set state before any agent is created
    await ctx.workdshToolGates.set({ computerUse: true, browserTools: false });

    // Verify get() reflects the set state
    const { state } = await ctx.workdshToolGates.get();
    assert.equal(state.computerUse, true);
    assert.equal(state.browserTools, false);

    // Now create an agent — it should inherit the already-applied state
    // Use a fresh context sharing the same storage to simulate a new session
    const freshCtx = new Context();
    const freshAgent = { id: 'agent-late', ctx: { tools: null } };
    freshCtx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    freshCtx.provide('agents', { list: () => [freshAgent], get: () => freshAgent });
    freshCtx.provide('connection', { fetch: { register: () => () => {} } });
    await freshCtx.plugin(Storage);
    await freshCtx.plugin(JsonStorage, { root });
    await freshCtx.plugin(StorageDomain, { backend: 'json' });
    await freshCtx.plugin(Tools);
    // Register the same fixture tools in the fresh context
    registerTool(freshCtx, 'cua_driver_native__keyboard_press');
    registerTool(freshCtx, 'mcp__playwright-mcp__navigate');
    registerTool(freshCtx, 'regular_tool');
    // Update the fresh agent's tools reference after Tools plugin loads
    freshAgent.ctx.tools = makeScopedTools(freshCtx.tools, 'agent-late');
    const freshBrowserCalls = provideBrowserSession(freshCtx, freshAgent.ctx.tools, ['mcp__playwright-mcp__navigate']);
    freshCtx.emit('agent/created', { agent: freshAgent });
    await freshCtx.plugin(ToolGatesManager);
    assert.equal(freshBrowserCalls.at(-1)?.enabled, false, 'new agent should inherit browser-off state');

    const names = freshAgent.ctx.tools.schemas().map(t => t.name);
    assert.ok(names.includes('cua_driver_native__keyboard_press'), 'computerUse should be available');
    assert.ok(!names.includes('mcp__playwright-mcp__navigate'), 'browserTools should be denied');
    assert.ok(names.includes('regular_tool'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
