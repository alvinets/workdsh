import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import type { ToolGatesState } from './shared.js';

export const toolGatesPath = '/api/workdsh-tool-gates';
const ok = <T>(value: T): ConnectionRpcResult<T> => ({ ok: true, value });
const fail = (code: string, message: string): ConnectionRpcResult<never> => ({ ok: false, error: { code, message, details: {} } });
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function registerToolGatesConnection(ctx: Context): void {
  const connection = (ctx as Context & { connection: HostConnectionHandle }).connection;
  const service = ctx.workdshToolGates;
  const unregister = connection.fetch.register({
    path: toolGatesPath,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const body = record(await request.json());
        const endpoint = body?.endpoint;
        const payload = record(body?.payload) ?? {};
        if (endpoint === 'get') return Response.json(ok(await service.get()), { headers: { 'cache-control': 'no-store' } });
        if (endpoint === 'set' && typeof payload === 'object' && payload !== null) {
          const state: Partial<ToolGatesState> = {};
          if (typeof payload.computerUse === 'boolean') state.computerUse = payload.computerUse;
          if (typeof payload.browserTools === 'boolean') state.browserTools = payload.browserTools;
          return Response.json(ok(await service.set(state)), { headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(fail('tool-gates/invalid-request', '请求参数无效。'), { status: 400 });
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : 'tool-gates/internal';
        return Response.json(fail(code, '工具门控操作失败，请重试。'));
      }
    },
  });
  ctx.effect(() => unregister, 'workdsh.toolGates.fetch');
}
