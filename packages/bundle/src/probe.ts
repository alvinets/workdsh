import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerBrowserView } from './browser-view.js';

/** Product diagnostics only. Feature packages are installed as separate Profile layers. */
export const name = 'workdsh-installation-probe';
export const inject = ['connection', 'tools', 'agents', 'attachments', 'systemPrompt'];

/**
 * Mirror the Host logger into a file.
 *
 * No console exporter ships in this profile — the only exporter available is the
 * OTLP one, which needs a collector URL — so `ctx.logger.warn(...)` output is
 * otherwise invisible. That hides exactly the diagnostics a long run needs: the
 * compaction handlers log their failures (`step compaction failed: …`,
 * `context-overflow compaction failed: …`) and nothing downstream reports them.
 *
 * Opt-in via WORKDSH_DEBUG_LOG=<path>; default under the Host home.
 */
function installLogMirror(ctx: Context): void {
  const path = process.env.WORKDSH_DEBUG_LOG
    ?? join(process.env.DSH_HOME ?? '.', 'logs', 'workdsh-debug.log');
  const render = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const exporter = {
    levels: { default: 3 },
    export(message: { ts: number; name: string; type: string; args: unknown[] }): void {
      const line = `${new Date(message.ts).toISOString()} [${message.type}] ${message.name} ${message.args.map(render).join(' ')}\n`;
      try {
        appendFileSync(path, line);
      } catch {
        // A diagnostics mirror must never break the Host.
      }
    },
  };
  ctx.logger.exporter(exporter);
  process.stdout.write(`[workdsh:probe] log mirror -> ${path}\n`);
}

export function apply(ctx: Context): void {
  registerBrowserView(ctx);
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'workdsh:browser-in-sidebar',
    order: ctx.systemPrompt.getSectionOrder('TOOL_REPORT'),
    text: 'For website browsing and page interaction in WorkDSH, use the available Playwright MCP browser tools. They keep the live Agent Session page visible and operable in the right sidebar. Use native computer control for other desktop apps, or when the user explicitly requests operating an existing external browser. Do not launch a separate visible system browser for an ordinary website task.',
  }), 'workdsh.browser-view.prompt');
  ctx.effect(() => {
    process.stdout.write('[workdsh:probe] activated\n');
    return () => process.stdout.write('[workdsh:probe] disposed\n');
  });
  installLogMirror(ctx);
}
