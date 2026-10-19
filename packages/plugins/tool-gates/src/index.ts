import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-tools';
import { registerToolGatesConnection } from './connection-api.js';
import { ToolGatesManager } from './manager.js';

export * from './shared.js';
export * from './connection-api.js';
export * from './manager.js';
export const name = 'workdsh-plugin-tool-gates';
export const inject = ['tools', 'agents', 'connection', 'storageDomain'];

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(ToolGatesManager);
  await ctx.plugin({
    name: 'workdsh-tool-gates-integration',
    inject: [...inject, 'workdshToolGates'],
    apply: registerToolGatesConnection,
  });
}
