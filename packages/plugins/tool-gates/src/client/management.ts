import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ToolGatesState, ToolGatesAvailable } from '../shared.js';

const path = '/api/workdsh-tool-gates';
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function invoke<T>(ctx: Context, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  void ctx;
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const result = await response.json() as { ok?: boolean; value?: unknown; error?: unknown };
  if (!result.ok) {
    const error = isRecord(result.error) ? result.error : {};
    throw new Error(typeof error.message === 'string' ? error.message : '工具门控操作失败，请重试。');
  }
  return result.value as T;
}

export function createToolGatesClient(ctx: Context, lifetime?: AbortSignal) {
  return {
    get: () => invoke<{ state: ToolGatesState; available: ToolGatesAvailable }>(ctx, 'get', {}, lifetime),
    set: (state: Partial<ToolGatesState>) => invoke<ToolGatesState>(ctx, 'set', state, lifetime),
  };
}
export type ToolGatesClient = ReturnType<typeof createToolGatesClient>;
