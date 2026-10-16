/*
 * `/skillhub` is owned by the third-party `@cocofhu/skillhub` plugin. When that plugin is
 * absent from the Profile the carrier answers 404 (GET) / 405 (POST) with an empty body,
 * so a bare `response.json()` throws `SyntaxError: Unexpected end of JSON input`. All
 * reads go through `readSkillHubResult`, which classifies that case instead of crashing.
 */

/** The `/skillhub` provider route is absent because no installed plugin registers it. */
export class SkillHubUnavailableError extends Error {
  constructor(message = 'SkillHub 服务不可用：当前 Profile 未安装 SkillHub 插件。') {
    super(message);
    this.name = 'SkillHubUnavailableError';
  }
}

/** Carrier statuses meaning "no plugin owns this route" rather than "the call failed". */
const ABSENT_ROUTE_STATUS = new Set([404, 405]);

function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export async function readSkillHubResult<T extends { ok: boolean; error?: string }>(response: Response): Promise<T> {
  const body = parseJsonBody(await response.text());
  if (body === null || typeof body !== 'object') {
    if (ABSENT_ROUTE_STATUS.has(response.status)) throw new SkillHubUnavailableError();
    if (!response.ok) throw new Error(`SkillHub 请求失败（HTTP ${response.status}）`);
    throw new Error('SkillHub 返回了无法解析的响应。');
  }
  const result = body as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error || `SkillHub 请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}

export async function callSkillHub<T extends { ok: boolean; error?: string }>(
  baseURI: string | URL,
  method: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(new URL('./skillhub', baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...payload }),
    signal,
  });
  return readSkillHubResult<T>(response);
}

/**
 * Report whether the SkillHub provider route is reachable.
 *
 * Returns `false` only for a definitive "no such route" (404/405); every other outcome
 * - including a network error - keeps the caller optimistic, so a transient failure
 * never hides a working catalog.
 */
export async function probeSkillHub(baseURI: string | URL, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(new URL('./skillhub', baseURI), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'version' }),
      signal,
    });
    return !ABSENT_ROUTE_STATUS.has(response.status);
  } catch {
    return true;
  }
}
