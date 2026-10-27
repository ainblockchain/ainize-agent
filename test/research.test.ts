import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { research, runTool, insideRoot } from '../src/research/index.ts';

function tree(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'research-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'); mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'store.ts'), 'export function getSession(id) {\n  return read(`state/${id}.json`);\n}\n');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  symlinkSync(join(dir, 'secret.txt'), join(root, 'link.txt'));
  return root;
}

test('tools read inside the root only', t => {
  const root = tree(t);
  assert.match(runTool(root, 'grep', { pattern: 'getSession' }), /src\/store\.ts:1:export function getSession/);
  assert.match(runTool(root, 'read_file', { path: 'src/store.ts', offset: 2, limit: 1 }), /^2\t  return read/);
  assert.match(runTool(root, 'glob', { pattern: '**/*.ts' }), /src\/store\.ts/);
  assert.match(runTool(root, 'read_file', { path: '../secret.txt' }), /outside the root/);
  assert.match(runTool(root, 'read_file', { path: 'link.txt' }), /outside the root/);
  assert.throws(() => insideRoot(root, '/etc/passwd'.replace(/^/, '../../../..')));
  assert.match(runTool(root, 'write_file', { path: 'x' }), /unknown tool/);
});

test('the loop runs tools, then returns the final answer', async t => {
  const root = tree(t);
  const bodies: any[] = [];
  let n = 0;
  const fetchImpl = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body); n++;
    const message = n === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"getSession"}' } }] }
      : { role: 'assistant', content: 'getSession 은 state/<id>.json 하나를 읽습니다 (src/store.ts:2).' };
    return new Response(JSON.stringify({ choices: [{ index: 0, message }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await research({ baseUrl: 'http://m', apiKey: 'k', model: 'DeepSeek-V4.1-Flash-1017', fetchImpl }, { root, system: 's', question: 'q' });
  assert.equal(r.answer, 'getSession 은 state/<id>.json 하나를 읽습니다 (src/store.ts:2).');
  assert.equal(r.toolCalls, 1);
  assert.match(bodies[1].messages.at(-1).content, /src\/store\.ts:1:export function getSession/);
  assert.equal(bodies[0].model, 'DeepSeek-V4.1-Flash-1017');
});

test('429 is reported as busy', async t => {
  const root = tree(t);
  const fetchImpl = (async () => new Response('busy', { status: 429 })) as typeof fetch;
  await assert.rejects(research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl }, { root, system: 's', question: 'q' }), (e: any) => e.busy === true);
});

const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

test('a dropped keep-alive connection is retried', async t => {
  const root = tree(t);
  let calls = 0;
  const fetchImpl = (async () => {
    if (++calls === 1) throw dropped();
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
  }) as typeof fetch;
  const r = await research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl }, { root, system: 's', question: 'q' });
  assert.equal(r.answer, 'done'); assert.equal(calls, 2);
});

test('repeated drops and other errors are not retried forever', async t => {
  const root = tree(t);
  let calls = 0;
  const always = (async () => { calls++; throw dropped(); }) as typeof fetch;
  await assert.rejects(research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl: always }, { root, system: 's', question: 'q' }), /fetch failed/);
  assert.equal(calls, 3);
  calls = 0;
  const other = (async () => { calls++; throw new TypeError('bad url'); }) as typeof fetch;
  await assert.rejects(research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl: other }, { root, system: 's', question: 'q' }), /bad url/);
  assert.equal(calls, 1);
});
