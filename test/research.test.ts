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

// A model server that streams: `gapMs` between chunks, or silence when `silent`.
async function streamingModel(t: any, o: { chunks: string[]; gapMs: number; silent?: boolean }) {
  const { createServer } = await import('node:http');
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', async () => {
      bodies.push(JSON.parse(raw));
      if (o.silent) return; // accepts the request and never answers
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of o.chunks) { await new Promise(r => setTimeout(r, o.gapMs)); if (res.destroyed) return; res.write(`data: ${c}\n\n`); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, bodies };
}
const delta = (d: unknown) => JSON.stringify({ choices: [{ index: 0, delta: d }] });

test('a long answer that keeps streaming is not cut by the timeout', async t => {
  const root = tree(t);
  // 8 chunks 60 ms apart = ~480 ms in total, against a 200 ms timeout: only silence may time out.
  const words = ['긴 ', '답변', '을 ', '끝', '까지 ', '받', '습니다', '.'];
  const m = await streamingModel(t, { gapMs: 60, chunks: [delta({ role: 'assistant', content: null }), delta({ reasoning_content: 'thinking' }), ...words.map(w => delta({ content: w }))] });
  const r = await research({ baseUrl: m.baseUrl, apiKey: 'k', model: 'm', timeoutMs: 200 }, { root, system: 's', question: 'q' });
  assert.equal(r.answer, '긴 답변을 끝까지 받습니다.');
  assert.equal(m.bodies[0].stream, true);
});

test('a model that goes silent still times out', async t => {
  const root = tree(t);
  const m = await streamingModel(t, { gapMs: 0, chunks: [], silent: true });
  const started = Date.now();
  await assert.rejects(research({ baseUrl: m.baseUrl, apiKey: 'k', model: 'm', timeoutMs: 150 }, { root, system: 's', question: 'q' }), /aborted due to timeout/);
  assert.ok(Date.now() - started < 2000);
  const stalls = await streamingModel(t, { gapMs: 400, chunks: [delta({ content: 'a' }), delta({ content: 'b' })] });
  await assert.rejects(research({ baseUrl: stalls.baseUrl, apiKey: 'k', model: 'm', timeoutMs: 150 }, { root, system: 's', question: 'q' }), /aborted due to timeout/);
});

test('streamed tool calls are put back together', async t => {
  const root = tree(t);
  let n = 0;
  const sse = (chunks: string[]) => new Response(chunks.map(c => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const bodies: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return ++n === 1
      ? sse([delta({ role: 'assistant', content: null }), delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"patt' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: 'ern":"getSession"}' } }] })])
      : sse([delta({ content: 'found' })]);
  }) as typeof fetch;
  const r = await research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl }, { root, system: 's', question: 'q' });
  assert.equal(r.answer, 'found'); assert.equal(r.toolCalls, 1);
  assert.deepEqual(bodies[1].messages.at(-2).tool_calls, [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"getSession"}' } }]);
  assert.match(bodies[1].messages.at(-1).content, /src\/store\.ts:1:/);
});

test('the final turn keeps the same tool list so the server can reuse its prompt cache', async t => {
  const root = tree(t);
  const bodies: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const message = bodies.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*.ts"}' } }] }
      : { role: 'assistant', content: 'final' };
    return Response.json({ choices: [{ message }] });
  }) as typeof fetch;
  const r = await research({ baseUrl: 'http://m', apiKey: 'k', model: 'm', fetchImpl }, { root, system: 's', question: 'q', maxTurns: 2 });
  assert.equal(r.answer, 'final'); assert.equal(r.stopped, 'turns');
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.equal(bodies[0].tool_choice, 'auto'); assert.equal(bodies[1].tool_choice, 'none');
});
