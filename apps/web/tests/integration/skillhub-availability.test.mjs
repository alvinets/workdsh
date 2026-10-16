import test from 'node:test';
import assert from 'node:assert/strict';
import { readSkillHubResult, probeSkillHub, SkillHubUnavailableError } from '../../../../packages/plugins/skills/dist/index.js';

test('the reported crash is reproduced by the previous bare response.json() pattern', async () => {
  const absent = new Response('', { status: 405 });
  await assert.rejects((async () => { await absent.json(); })(), SyntaxError);
});

test('an absent provider route raises SkillHubUnavailableError, not a JSON SyntaxError', async () => {
  await assert.rejects(readSkillHubResult(new Response('', { status: 405 })), error => {
    assert.equal(error instanceof SkillHubUnavailableError, true);
    assert.match(error.message, /SkillHub/);
    return true;
  });
});

test('a 404 on the provider route is also classified as unavailable', async () => {
  await assert.rejects(readSkillHubResult(new Response('', { status: 404 })), SkillHubUnavailableError);
});

test('a successful payload is returned untouched', async () => {
  const payload = { ok: true, items: [{ slug: 'demo' }], total: 1 };
  assert.deepEqual(await readSkillHubResult(new Response(JSON.stringify(payload), { status: 200 })), payload);
});

test('a provider-level failure surfaces its own message', async () => {
  await assert.rejects(
    readSkillHubResult(new Response(JSON.stringify({ ok: false, error: '安装被拒绝' }), { status: 200 })),
    /安装被拒绝/,
  );
});

test('a non-JSON 5xx body is reported as an HTTP failure, not a parse error', async () => {
  await assert.rejects(readSkillHubResult(new Response('<html>oops</html>', { status: 500 })), /HTTP 500/);
});

test('a malformed JSON body on an OK status fails descriptively', async () => {
  await assert.rejects(readSkillHubResult(new Response('{not json', { status: 200 })), /无法解析/);
});

test('probeSkillHub reports an absent route as unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 405 });
  try {
    assert.equal(await probeSkillHub('http://localhost/'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('probeSkillHub reports a served route as available', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, version: '0.2.16' }), { status: 200 });
  try {
    assert.equal(await probeSkillHub('http://localhost/'), true);
  } finally {
    globalThis.fetch = original;
  }
});

test('probeSkillHub fails open on a transient network error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    assert.equal(await probeSkillHub('http://localhost/'), true);
  } finally {
    globalThis.fetch = original;
  }
});
