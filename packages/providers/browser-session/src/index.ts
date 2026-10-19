/** Session-owned Chromium feeding the official Playwright MCP tool client. */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand';
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import type {} from '@deepseek-ai/dsh-browser-use';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { launchManagedChromium, type ManagedChromium } from './managed-chromium.js';
import { launchManagedElectron } from './managed-electron.js';
import { registerBrowserSessionConnection } from './remote.js';

/** A rendered view of the same page controlled by the Session's MCP tools. */
export interface BrowserFrame {
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly jpegBase64: string;
}

/** Host-only operations. A Remote adapter must resolve the authenticated live Agent first. */
export interface BrowserSessionView {
  available(agent: Agent): boolean;
  active(agent: Agent): boolean;
  setToolsEnabled(agent: Agent, enabled: boolean): Promise<void>;
  toolsEnabled(agent: Agent): boolean;
  capture(agent: Agent, signal: AbortSignal): Promise<BrowserFrame>;
  click(agent: Agent, x: number, y: number, signal: AbortSignal): Promise<BrowserFrame>;
  type(agent: Agent, text: string, signal: AbortSignal): Promise<BrowserFrame>;
  press(agent: Agent, key: string, signal: AbortSignal): Promise<BrowserFrame>;
  scroll(agent: Agent, deltaX: number, deltaY: number, signal: AbortSignal): Promise<BrowserFrame>;
  navigate(agent: Agent, url: string, signal: AbortSignal): Promise<BrowserFrame>;
}

declare module '@deepseek-ai/cordis' {
  interface Context { workdshBrowserSession: BrowserSessionView; }
}

export const name = 'workdsh-browser-session';
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt'];

export interface Config {
  /** Desktop reuses its own Electron Chromium in a private worker process. */
  electronExecutable?: string;
  /** Web-only fallback when Desktop's Electron worker is unavailable. */
  executablePath?: string;
  toolCallTimeoutMs?: number;
}

interface BrowserResource {
  browser: ManagedChromium;
  disposeListener: () => void;
  mcp?: Scope;
  closed?: boolean;
}

const MCP_NAME = 'workdsh-playwright';
const TOOL_PREFIX = `mcp__${MCP_NAME}__`;
const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

/** Register only for future Agent activations; existing sessions keep their original provider. */
export function apply(ctx: Context, config: Config = {}): void {
  if (!config.electronExecutable?.trim() && !config.executablePath?.trim()) {
    throw new Error('workdsh-browser-session: Electron worker or browser executable is required');
  }
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js');
  const scrubbedMcpEnv = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']));
  let resources!: SessionResources<BrowserResource>;
  const ready = new Set<Agent>();
  const active = new Set<Agent>();
  const mcpReady = new Set<Agent>();
  const mcpQueues = new Map<Agent, Promise<void>>();
  let stopping = false;

  const view = async (
    agent: Agent,
    signal: AbortSignal,
    action?: (page: import('playwright-core').Page) => Promise<void>,
  ): Promise<BrowserFrame> => {
    if (stopping || !ready.has(agent)) throw new Error(`${MCP_NAME}: Session browser is unavailable`);
    return resources.run(agent, signal, async ({ browser }, combined) => {
      combined.throwIfAborted();
      const page = browser.context.pages().at(-1);
      if (!page || page.isClosed()) throw new Error(`${MCP_NAME}: Session has no browser page`);
      await action?.(page);
      combined.throwIfAborted();
      const viewport = page.viewportSize();
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
      combined.throwIfAborted();
      return {
        url: page.url(),
        title: await page.title(),
        width: viewport?.width ?? 1280,
        height: viewport?.height ?? 720,
        jpegBase64: jpeg.toString('base64'),
      };
    });
  };
  const mountMcp = async (agent: Agent, browser: ManagedChromium): Promise<Scope> => {
    const scope = createScope(ctx, agent);
    try {
      await scope.ctx.plugin(McpClient, McpClient.Config({
        transport: 'stdio',
        serverName: MCP_NAME,
        command: process.execPath,
        args: [cli, '--browser', 'chromium', '--cdp-endpoint', browser.endpoint],
        env: scrubbedMcpEnv,
        ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
        ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
        failOnStartupError: true,
        reconnect: { enabled: false },
      }));
      return scope;
    } catch (error) {
      await scope.dispose();
      throw error;
    }
  };

  const setToolsEnabled = (agent: Agent, enabled: boolean): Promise<void> => {
    const previous = mcpQueues.get(agent) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (stopping || !resources) return;
      let resource: BrowserResource;
      try { resource = await resources.get(agent); }
      catch { return; }
      if (resource.closed) return;
      if (enabled) {
        if (resource.mcp !== undefined) return;
        const mcp = await mountMcp(agent, resource.browser);
        if (resource.closed) { await mcp.dispose(); return; }
        resource.mcp = mcp;
        mcpReady.add(agent);
      } else if (resource.mcp !== undefined) {
        const mcp = resource.mcp;
        resource.mcp = undefined;
        mcpReady.delete(agent);
        await mcp.dispose();
      }
    });
    mcpQueues.set(agent, task);
    return task.finally(() => {
      if (mcpQueues.get(agent) === task) mcpQueues.delete(agent);
    });
  };

  ctx.provide('workdshBrowserSession', {
    available: agent => !stopping && ready.has(agent) && resources.available(agent),
    active: agent => !stopping && active.has(agent) && resources.available(agent),
    setToolsEnabled,
    toolsEnabled: agent => !stopping && mcpReady.has(agent),
    capture: (agent, signal) => view(agent, signal),
    click: (agent, x, y, signal) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10_000 || y > 10_000) {
        throw new Error('browser click coordinates are invalid');
      }
      return view(agent, signal, page => page.mouse.click(x, y));
    },
    type: (agent, value, signal) => {
      if (typeof value !== 'string' || value.length > 4_000) throw new Error('browser text input is invalid');
      return view(agent, signal, page => page.keyboard.insertText(value));
    },
    press: (agent, key, signal) => {
      if (!['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
        throw new Error('browser key is invalid');
      }
      return view(agent, signal, page => page.keyboard.press(key));
    },
    scroll: (agent, deltaX, deltaY, signal) => {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)
        || Math.abs(deltaX) > 10_000 || Math.abs(deltaY) > 10_000) {
        throw new Error('browser scroll deltas are invalid');
      }
      return view(agent, signal, page => page.mouse.wheel(deltaX, deltaY));
    },
    navigate: (agent, value, signal) => {
      let url: URL;
      try { url = new URL(value); }
      catch { throw new Error('browser URL is invalid'); }
      if (!['http:', 'https:'].includes(url.protocol) || value.length > 2_048) {
        throw new Error('browser URL is invalid');
      }
      return view(agent, signal, async page => { await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 }); });
    },
  } satisfies BrowserSessionView);
  ctx.inject(['connection', 'workdshIdentity'], remote => registerBrowserSessionConnection(remote));

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(MCP_NAME));
    resources = new SessionResources(ctx, {
      label: MCP_NAME,
      exclusive: false,
      async open(agent, signal) {
        const browser = config.electronExecutable?.trim()
          ? await launchManagedElectron(config.electronExecutable, signal)
          : await launchManagedChromium(config.executablePath!, signal);
        try {
          signal.throwIfAborted();
          const disposeListener = agent.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(TOOL_PREFIX)) return next();
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next();
              throw new Error(`${MCP_NAME}: browser tool belongs to another Session`);
            }
            return next();
          });
          const resource: BrowserResource = { browser, disposeListener };
          signal.throwIfAborted();
          return {
            value: resource,
            async close() {
              resource.closed = true;
              ready.delete(agent);
              active.delete(agent);
              mcpReady.delete(agent);
              mcpQueues.delete(agent);
              try { await resource.mcp?.dispose(); }
              finally {
                resource.mcp = undefined;
                resource.disposeListener();
                await browser.close();
              }
            },
          };
        } catch (error) {
          try { await browser.close(); }
          finally { throw error; }
        }
      },
    });
    yield async () => {
      stopping = true;
      await resources.dispose();
      ready.clear();
      active.clear();
    };
  }, 'workdsh.browser.sessions');

  ctx.on('agent/created', async ({ agent, signal }) => {
    await resources.get(agent, signal);
    ready.add(agent);
    const gates = (ctx as unknown as {
      get(name: string): { getSync(): { state: { browserTools: boolean } } } | undefined;
    }).get('workdshToolGates');
    let enabled = true;
    try { enabled = gates?.getSync().state.browserTools ?? true; }
    catch { enabled = true; }
    if (enabled) {
      await setToolsEnabled(agent, true).catch(error => {
        ctx.logger.warn(`${MCP_NAME}: browser tool mount failed: ${String(error)}`);
      });
    }
    agent.ctx.effect(() => () => {
      ready.delete(agent);
      active.delete(agent);
      mcpReady.delete(agent);
    }, 'workdsh.browser.activation');
  }, { prepend: true });

  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = RESOURCE_TOOLS.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === MCP_NAME;
    if (!exec.name.startsWith(TOOL_PREFIX) && !ownResource) return next();
    const agent = exec.agent;
    if (stopping || agent === undefined || !ready.has(agent)) {
      throw new Error(`${MCP_NAME}: browser tool belongs to another Session`);
    }
    return resources.run(agent, exec.signal, async (_resource, combined) => {
      const original = exec.signal;
      exec.signal = combined;
      try {
        const result = await next();
        if (exec.name.startsWith(`${TOOL_PREFIX}browser_`) && !result.isError) active.add(agent);
        return result;
      }
      finally { exec.signal = original; }
    });
  });
}
