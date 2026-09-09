/**
 * The agent's memory (G1). Everything here runs with no GPU, no node and no network except one local HTTP server
 * standing in for `GET /api/runtime` — the endpoint is public, so a fixture of its real body is a fair stand-in for
 * the shape, and the live drive against a real node is recorded in the session report rather than pinned here.
 *
 * The load-bearing assertion is the first one: our question key must be the NODE's question key, or a fact learned
 * from a training set and the same question typed by a person land on two different rows and the memory silently
 * answers nothing. `@ainize/mcp`'s row normaliser is itself pinned to the node's `teach-dataset.ts`
 * (`packages/mcp/test/rows.test.ts`), so pinning to it pins to the node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// the MCP package's copy — which is the node's copy. Imported by path because `@ainize/mcp` exports no `./rows`
// subpath yet (G2 adds `./client` and `./money`); when it does, `memory.ts` imports it and this test still holds.
import { normalizeTeachRow, promptKey } from '@ainize/mcp';
import {
  AgentMemory, ANSWER_TTL_MS, answerMatches, answerCacheKey, clearRuntimeCache, decideRecall, emptyIndex, fetchRuntime,
  fold, loadIndex, memoryFile, memoryIndexFile, memoryView, normalizeAnswer, recallMismatchLine, rowKey, runtimeLine,
  stackFingerprint,
  type MemoryEvent, type RuntimeLayer, type RuntimeView,
} from '../src/memory.js';
import { MEMORY_STRINGS } from '../src/strings/memory.js';
import { translator } from '../src/i18n.js';

const homes: string[] = [];
const newHome = (): string => { const h = mkdtempSync(join(tmpdir(), 'ainize-agent-mem-')); homes.push(h); return h; };
process.on('exit', () => { for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ } } });

const layer = (patch_id: string, sha256: string, position: number): RuntimeLayer => ({ patch_id, sha256, position });
const runtime = (model: string | null, stack: RuntimeLayer[], ok = true): RuntimeView => ({
  ok, url: 'http://localhost:4110/api/runtime', api: 'http://127.0.0.1:9', model, stack, checked: null,
  stack_fp: ok ? stackFingerprint(model, stack) : null, at: Date.now(),
});

// ------------------------------------------------------------------ the key is the node's key

test('the question key is the node\'s own promptKey, character for character', () => {
  const questions = [
    '픽셀플러스의  종목코드는?',
    'What is the WETH address?',
    'Q: Who indexes this?\nA:',
    '  spaced   out\tquestion  ',
    'zero​width',
    'NFC 한글 조합가',
  ];
  for (const q of questions) assert.equal(rowKey(q), promptKey({ prompt: q, answer: 'x' }), q);
  // the answer side too — a remembered answer is compared against a model completion after this normalisation
  for (const a of ['0x0000', ' two  spaces ', 'line\nbreak', 'tab\there']) {
    assert.equal(normalizeAnswer(a), normalizeTeachRow({ prompt: 'q', answer: a }).answer);
  }
});

test('answerMatches is the agent\'s own scoring rule: a prefix of the completion, normalised and case-folded', () => {
  assert.ok(answerMatches('087600', '087600 입니다'));
  assert.ok(answerMatches('0xC02AAA', '0xc02aaa39b223fe8d'));
  assert.ok(answerMatches('two  spaces', ' two spaces and more'));
  assert.ok(!answerMatches('087600', '005930'));
  assert.ok(!answerMatches('', 'anything'), 'an empty memory never "matches"');
});

// ------------------------------------------------------------------ the log and the derived index

test('a fact is on disk before it is in the index, and the index is exactly a fold of the log', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  assert.equal(mem.isEmpty, true);
  assert.equal(mem.exists, false);
  mem.learn([
    { prompt: '픽셀플러스 종목코드', answer: '087600', source: 'anchor', engram: 'pixelplus-087600' },
    { prompt: 'What is the WETH address?', answer: '0xc02a', source: 'retrieval', shape: 'sh_weth' },
  ]);
  const lines = readFileSync(memoryFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as MemoryEvent);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((e) => e.kind), ['learn', 'learn']);
  assert.equal(lines[0].v, 1);
  assert.equal(mem.index.rows['픽셀플러스 종목코드'].answer, '087600');
  assert.equal(mem.index.rows['픽셀플러스 종목코드'].engram, 'pixelplus-087600');
  // fold(replay) === live index
  const replayed = emptyIndex();
  for (const e of lines) fold(replayed, e);
  assert.deepEqual(replayed.rows, mem.index.rows);
  assert.equal(mem.index.events, 2);
  // an empty question or an empty answer is not a fact
  mem.learn([{ prompt: '   ', answer: 'x', source: 'anchor' }, { prompt: 'q', answer: '  ', source: 'anchor' }]);
  assert.equal(mem.index.events, 2);
});

test('the snapshot records the offset it was built through, and deleting it costs a replay, never a fact', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }]);
  mem.save();
  const snap = JSON.parse(readFileSync(memoryIndexFile(home), 'utf8')) as { through_offset: number; rows: Record<string, unknown> };
  assert.equal(snap.through_offset, statSync(memoryFile(home)).size);
  assert.ok(snap.rows['a?']);
  // a second process appends; the first one picks it up from the stored offset, not from zero
  const other = AgentMemory.open(home);
  other.learn([{ prompt: 'b?', answer: '2', source: 'retrieval', shape: 'sh' }]);
  assert.equal(mem.index.rows['b?'], undefined, 'not seen until the tail is read');
  mem.refresh();
  assert.equal(mem.index.rows['b?'].answer, '2');
  assert.equal(mem.index.events, 2);
  // deleting the snapshot loses nothing
  rmSync(memoryIndexFile(home));
  assert.deepEqual(loadIndex(home).rows, mem.index.rows);
  assert.equal(loadIndex(home).events, 2);
});

test('a replaced or truncated log is replayed whole rather than half-trusted', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor' }, { prompt: 'b?', answer: '2', source: 'anchor' }]);
  mem.save();
  // somebody replaced the log with a different one of the same shape
  writeFileSync(memoryFile(home), JSON.stringify({ v: 1, at: Date.now(), kind: 'learn', row_key: 'c?', answer: '3', source: 'anchor', engram: null, shape: null }) + '\n');
  const fresh = loadIndex(home);
  assert.deepEqual(Object.keys(fresh.rows), ['c?'], 'the stale snapshot was not merged into a different log');
  assert.equal(fresh.events, 1);
});

test('a half-written last line is not consumed until it is complete', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor' }]);
  const partial = '{"v":1,"at":1,"kind":"learn","row_key":"b?","answer":"2","source":"anch';
  appendFileSync(memoryFile(home), partial);
  const before = loadIndex(home);
  assert.equal(before.events, 1);
  assert.equal(before.through_offset, statSync(memoryFile(home)).size - partial.length);
  appendFileSync(memoryFile(home), 'or","engram":null,"shape":null}\n');
  const after = loadIndex(home);
  assert.equal(after.events, 2);
  assert.equal(after.rows['b?'].answer, '2');
});

// ------------------------------------------------------------------ the stack fingerprint

test('the stack fingerprint changes on anything that changes the model, and on nothing else', () => {
  const a = layer('k1', 'aaa', 0), b = layer('k2', 'bbb', 1);
  const base = stackFingerprint('qwen3-8b', [a, b]);
  assert.equal(base, stackFingerprint('qwen3-8b', [b, a]), 'the order the node listed them in is not a difference');
  assert.notEqual(base, stackFingerprint('qwen3-8b', [a]), 'a layer removed');
  assert.notEqual(base, stackFingerprint('qwen3-8b', [a, b, layer('k3', 'ccc', 2)]), 'a layer added');
  assert.notEqual(base, stackFingerprint('qwen3-8b', [{ ...a, position: 1 }, { ...b, position: 0 }]), 'reordered');
  assert.notEqual(base, stackFingerprint('qwen3-8b', [a, { ...b, sha256: 'zzz' }]), 're-bodied');
  assert.notEqual(base, stackFingerprint('other-model', [a, b]), 'a different model');
  assert.notEqual(stackFingerprint(null, []), stackFingerprint('qwen3-8b', []));
});

// ------------------------------------------------------------------ recall (§4)

test('recall decides at zero completions, and the cache is keyed by the state of the model', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  const fp = stackFingerprint('qwen3-8b', [layer('k1', 'aaa', 0)]);
  const otherFp = stackFingerprint('qwen3-8b', [layer('k1', 'aaa', 0), layer('foreign', 'fff', 1)]);

  // a miss is a miss: no model, no network, one map lookup
  assert.equal(mem.recall('불명 질문', { stackFp: fp, hasModel: true }).decision, 'miss');

  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }]);
  mem.recordApply({ patch_id: 'k1', sha256: 'aaa', position: 0, stack_fp_after: fp });
  // resident + a model to ask ⇒ exactly one completion, which is both the check and the answer
  const confirm = mem.recall('a?', { stackFp: fp, hasModel: true });
  assert.equal(confirm.decision, 'confirm');
  assert.equal(confirm.resident, true);
  assert.equal(confirm.answer, '1');

  // that completion agreed ⇒ cached against THIS fingerprint
  mem.recordRecall({ row_key: 'a?', shape: null, hit: true, via: 'model', engram: 'k1', stack_fp: fp, ms: 420, tokens: 6, answer: '1' });
  const cached = mem.recall('a?', { stackFp: fp, hasModel: true });
  assert.equal(cached.decision, 'cache');
  assert.equal(cached.answer, '1');
  assert.equal(mem.recall('a?', { stackFp: otherFp, hasModel: true }).decision, 'confirm', 'another tenant\'s layer invalidates the cached answer');
  assert.equal(mem.recall('a?', { stackFp: fp, hasModel: true, now: Date.now() + ANSWER_TTL_MS + 1 }).decision, 'confirm', 'and so does a day');

  // no model at all: the remembered answer, labelled as remembered
  const offline = mem.recall('a?', { stackFp: null, hasModel: false });
  assert.equal(offline.decision, 'offline');
  assert.equal(offline.reason, 'no_model');
  assert.equal(offline.answer, '1');
});

test('the model is the truth: a mismatch demotes the fact and the next question falls through to the cost path', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  const fp = stackFingerprint('m', [layer('k1', 'aaa', 0)]);
  mem.learn([{ prompt: 'a?', answer: '087600', source: 'anchor', engram: 'k1' }]);
  mem.recordApply({ patch_id: 'k1', sha256: 'aaa', position: 0, stack_fp_after: fp });
  mem.recordRecall({ row_key: 'a?', shape: null, hit: false, via: 'model', engram: 'k1', stack_fp: fp, ms: 380, answer: '005930' });
  assert.equal(mem.index.rows['a?'].state, 'unverified');
  const again = mem.recall('a?', { stackFp: fp, hasModel: true });
  assert.equal(again.decision, 'miss');
  assert.equal(again.reason, 'unverified');
  assert.match(recallMismatchLine('a?', '087600', '005930\n'), /"005930".*"087600"/s);
});

test('only a model\'s answer is cached — memory never quotes its own belief back as a confirmation', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  const fp = stackFingerprint('m', []);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'retrieval', shape: 'sh' }]);
  mem.recordRecall({ row_key: 'a?', shape: 'sh', hit: true, via: 'memory', engram: null, stack_fp: fp, ms: 0, answer: '1' });
  assert.deepEqual(mem.index.answers, {}, 'an answer that was never checked against a model is not a cached answer');
  assert.equal(mem.recall('a?', { stackFp: fp, hasModel: false }).decision, 'offline');
});

test('a fact the agent retrieved itself needs no knowledge on the model to be recalled', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'weth?', answer: '0xc02a', source: 'retrieval', shape: 'sh_weth' }]);
  const r = mem.recall('weth?', { stackFp: null, hasModel: false });
  assert.equal(r.decision, 'offline');
  assert.equal(r.resident, true, 'the agent\'s own fact is in the agent, not on the model');
  assert.equal(r.answer, '0xc02a');
});

// ------------------------------------------------------------------ §5.3, the retroactive row counter

test('classifyRows counts what was already paid for, and what moved', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'usdc?', answer: '0xa0b8', source: 'retrieval', shape: 'sh' }]);
  const c = mem.classifyRows([
    { prompt: 'usdc?', answer: '0xa0b8' },     // refetched, same answer
    { prompt: 'weth?', answer: '0xc02a' },     // new
    { prompt: 'usdc?', answer: '0xa0b8' },     // the same row twice in one pull is one row
  ]);
  assert.deepEqual({ ...c, keys: c.keys.length }, { keys: 2, new_rows: 1, refetched: 1, churned: 0 });
  mem.learn([{ prompt: 'weth?', answer: '0xc02a', source: 'retrieval', shape: 'sh' }]);
  const moved = mem.classifyRows([{ prompt: 'weth?', answer: '0xDEAD' }]);
  assert.equal(moved.churned, 1, 'a fact whose answer moved is the counter-signal, not evidence to compile');
});

// ------------------------------------------------------------------ reconciliation (§2, rules 1-4)

test('rule 1 — memory says loaded, the node does not list it: demoted to held, both sides written down', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  const fp = stackFingerprint('m', [layer('k1', 'aaa', 0)]);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }]);
  mem.recordApply({ patch_id: 'k1', sha256: 'aaa', position: 0, stack_fp_after: fp });
  assert.equal(mem.index.engrams.k1.state, 'loaded');

  const report = mem.reconcile(runtime('m', []), { purchases: [{ patch_id: 'k1', sha256: 'aaa' }] });
  assert.equal(report.fired.length, 1);
  assert.equal(report.fired[0].rule, 1);
  assert.equal(report.fired[0].agent_says, 'loaded');
  assert.equal(report.fired[0].node_says, 'not in the applied stack');
  assert.equal(mem.index.engrams.k1.state, 'held');
  assert.deepEqual(report.demoted.map((d) => d.line), ['k1 — state loaded → held']);
  assert.equal(mem.index.rows['a?'].state, 'known', 'the FACT is still known — only residency was demoted');
  // recall may not claim the model knows it
  const r = mem.recall('a?', { stackFp: runtime('m', []).stack_fp, hasModel: true });
  assert.equal(r.decision, 'offline');
  assert.equal(r.reason, 'not_resident');
  // and the conflict is on disk with both sides
  const conflict = readFileSync(memoryFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as MemoryEvent).find((e) => e.kind === 'conflict');
  assert.ok(conflict && conflict.kind === 'conflict' && conflict.rule === 1 && conflict.what === 'k1');
});

test('rule 1 again — a layer the node LISTS but measured as absent is not residency either', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }]);
  mem.recordApply({ patch_id: 'k1', sha256: 'aaa', position: 0, stack_fp_after: 'fp' });
  const measured: RuntimeLayer = { patch_id: 'k1', sha256: 'aaa', position: 0, present: false, checked_at: 1_700_000_000_000 };
  const report = mem.reconcile(runtime('m', [measured]));
  assert.equal(report.fired[0].rule, 1);
  assert.equal(report.fired[0].node_says, 'listed, but measured as not on the live table');
  assert.equal(mem.index.engrams.k1.state, 'held');
  assert.equal(mem.recall('a?', { stackFp: 'fp', hasModel: true }).reason, 'not_resident');
});

test('rule 2 — a layer the agent does not own is left alone, counted in the fingerprint, and recorded once', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }]);
  const view = runtime('m', [layer('k1', 'aaa', 0), layer('someone-else', 'fff', 1)]);
  const first = mem.reconcile(view, { purchases: [{ patch_id: 'k1', sha256: 'aaa' }] });
  assert.deepEqual(first.foreign, ['someone-else']);
  assert.equal(first.fired.filter((f) => f.rule === 2).length, 1);
  assert.equal(mem.index.engrams['someone-else'], undefined, 'a foreign layer never becomes this agent\'s memory');
  assert.equal(mem.index.rows['a?'].state, 'known');
  const conflicts = () => readFileSync(memoryFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as MemoryEvent).filter((e) => e.kind === 'conflict').length;
  const once = conflicts();
  mem.reconcile(view, { purchases: [{ patch_id: 'k1', sha256: 'aaa' }] });
  assert.equal(conflicts(), once, 'a layer that is simply always there is recorded once, not once per run');
});

test('rule 3 — the same id with a different body demotes the knowledge and everything learned from it', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'anchor', engram: 'k1' }, { prompt: 'b?', answer: '2', source: 'retrieval', shape: 'sh' }]);
  mem.recordBuy({ patch_id: 'k1', sha256: 'aaa', amount: '0.1', currency: 'AIN', tx_hash: '0xtx', seller: '0xseller', rows_learned: 1 });
  const report = mem.reconcile(runtime('m', [layer('k1', 'zzz', 0)]));
  assert.equal(report.fired[0].rule, 3);
  assert.equal(mem.index.engrams.k1.state, 'unverified');
  assert.equal(mem.index.rows['a?'].state, 'unverified');
  assert.equal(mem.index.rows['b?'].state, 'known', 'a fact from another source is untouched');
  assert.equal(mem.recall('a?', { stackFp: null, hasModel: false }).decision, 'miss');
});

test('rule 4 — a wiped home rebuilds residency, ownership and coverage, and says the lookup history is gone', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  const report = mem.reconcile(runtime('m', [layer('k1', 'aaa', 0)]), {
    purchases: [{ patch_id: 'k1', sha256: 'aaa', amount: '0.1', currency: 'AIN', at: 1_700_000_000_000 }],
    anchors: [{ patch_id: 'k1', sha256: 'aaa', samples: [{ prompt: '픽셀플러스 종목코드', expect: '087600' }, { prompt: 'a?', expect: '1' }] }],
  });
  assert.deepEqual(report.rebuilt, { engrams: 1, rows: 2 });
  assert.equal(report.memory_empty, true);
  assert.equal(mem.index.engrams.k1.state, 'loaded', 'residency comes from the node');
  assert.equal(mem.index.rows['픽셀플러스 종목코드'].answer, '087600');
  assert.deepEqual(mem.index.shapes, {}, 'the lookup history is NOT rebuilt — shape counters restart at zero');
  const buy = readFileSync(memoryFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as MemoryEvent).find((e) => e.kind === 'buy');
  assert.ok(buy && buy.kind === 'buy' && buy.rebuilt === true && buy.amount === '0.1', 'a reconstruction is marked, and the amount is the receipt\'s');
  const applied = readFileSync(memoryFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as MemoryEvent).find((e) => e.kind === 'apply');
  assert.ok(applied && applied.kind === 'apply' && applied.observed === true, 'the agent did not apply it — the node reported it');
});

test('a node that cannot be reached demotes nothing: unknown is not the same as empty', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  mem.recordApply({ patch_id: 'k1', sha256: 'aaa', position: 0, stack_fp_after: 'fp' });
  const down: RuntimeView = { ok: false, url: 'http://localhost:4110/api/runtime', api: null, model: null, stack: [], checked: null, stack_fp: null, at: Date.now(), error: 'fetch failed' };
  const report = mem.reconcile(down);
  assert.equal(report.fired.length, 0);
  assert.equal(mem.index.engrams.k1.state, 'loaded');
  assert.match(report.lines[0], /api\/runtime/);
});

// ------------------------------------------------------------------ the public runtime read

test('fetchRuntime reads the public endpoint, fingerprints it, and caches it for five seconds', async () => {
  clearRuntimeCache();
  let hits = 0;
  const body = {
    available: true, api: 'http://127.0.0.1:9', model: 'qwen3-8b', hook: true, applied: ['k1'],
    stack: [{ patch_id: 'k1', name: 'demo', sha256: 'aaa', position: 0, applied_at: 1, reason: 'manual', rows: 3, journal: true, body_present: true, present: null, checked_at: null }],
    checked: null,
  };
  const server = createServer((req, res) => {
    hits += 1;
    if (req.headers.authorization || req.headers['x-ainize-auth']) { res.writeHead(500); res.end('the agent is not the operator'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const v = await fetchRuntime(`http://127.0.0.1:${port}`);
    assert.equal(v.ok, true);
    assert.equal(v.model, 'qwen3-8b');
    assert.equal(v.stack.length, 1);
    assert.equal(v.stack_fp, stackFingerprint('qwen3-8b', [layer('k1', 'aaa', 0)]));
    assert.equal(hits, 1);
    await fetchRuntime(`http://127.0.0.1:${port}`);
    assert.equal(hits, 1, 'the second read inside five seconds is the cached one');
    const later = await fetchRuntime(`http://127.0.0.1:${port}`, { now: Date.now() + 6_000 });
    assert.equal(hits, 2);
    assert.equal(later.ok, true);
    assert.match(runtimeLine(later), /qwen3-8b/);
  } finally { server.close(); clearRuntimeCache(); }
});

test('a node that answers nothing is `ok:false` with the reason, never an empty stack', async () => {
  clearRuntimeCache();
  const v = await fetchRuntime('http://127.0.0.1:9', { timeoutMs: 500 });
  assert.equal(v.ok, false);
  assert.equal(v.stack_fp, null);
  assert.ok(v.error && v.error.length > 0);
  assert.match(runtimeLine(v), /no runtime|런타임/);
  clearRuntimeCache();
});

// ------------------------------------------------------------------ the `agent memory` view

test('the view counts only what is on disk', () => {
  const home = newHome();
  const mem = AgentMemory.open(home);
  assert.equal(memoryView(mem).exists, false);
  assert.match(memoryView(mem).summary, /nothing in memory yet/);
  mem.learn([{ prompt: 'a?', answer: '1', source: 'retrieval', shape: 'sh_1' }, { prompt: 'b?', answer: '2', source: 'retrieval', shape: 'sh_1' }]);
  mem.recordRetrieve({ shape: 'sh_1', plan_id: 'graph/erc20', arguments_sha256: 'f'.repeat(64), rows: 2, new_rows: 2, refetched: 0, churned: 0, queries: 1, bytes: 4096, ms: 1200 });
  mem.recordRetrieve({ shape: 'sh_1', plan_id: 'graph/erc20', arguments_sha256: 'e'.repeat(64), rows: 2, new_rows: 0, refetched: 2, churned: 1, queries: 1, bytes: 4096, ms: 800 });
  mem.recordBuy({ patch_id: 'k1', sha256: 'aaa', amount: '0.1', currency: 'AIN', tx_hash: '0xtx', seller: '0xs', rows_learned: 2 });
  const v = memoryView(mem);
  assert.equal(v.facts, 2);
  assert.equal(v.engrams_by_state.held, 1);
  assert.equal(v.engrams_by_state.loaded, 0, 'buying is not loading');
  assert.equal(v.shapes.length, 1);
  const s = v.shapes[0];
  assert.equal(s.lookups, 2);
  assert.equal(s.distinct_rows, 2);
  assert.equal(s.refetched, 2);
  assert.equal(s.churned, 1);
  assert.equal(s.churn_rate, 0.5);
  assert.deepEqual(s.measurements, { retrieval: 2, recall: 0, bake: 0 });
  assert.deepEqual(s.per_lookup, { ms: 1000, queries: 1, bytes: 4096 });
  assert.equal(s.per_recall, null, 'nothing recalled yet — the other side of N* is not invented');
  assert.match(v.summary, /facts 2/);
  assert.equal(v.counts.retrieve, 2);
});

// ------------------------------------------------------------------ the strings

test('every line ships in English and Korean, and neither says "(s)"', () => {
  const en = translator(MEMORY_STRINGS, 'en');
  const ko = translator(MEMORY_STRINGS, 'ko');
  for (const [key, entry] of Object.entries(MEMORY_STRINGS)) {
    assert.ok(entry.en.trim().length > 0, `${key} has no English`);
    assert.ok(entry.ko.trim().length > 0, `${key} has no Korean`);
    assert.match(entry.ko, /[가-힣]/, `${key}'s Korean is not written in Korean`);
    assert.doesNotMatch(entry.en, /\((s|es)\)/, `${key} uses the "(s)" convention and this CLI has no plural resolver`);
    assert.doesNotMatch(entry.ko, /[을이가은는와과]\(/, `${key} uses the Korean particle-alternate convention and this CLI has no josa resolver`);
    // the same slots on both sides, or one language silently loses a number
    const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(slots(entry.ko), slots(entry.en), `${key}'s two languages interpolate different values`);
    assert.notEqual(en(key), key);
    assert.notEqual(ko(key), key);
  }
  assert.match(ko('mem.conflict.notResident', { patch: 'k1' }), /^k1 — 기억에는/);
  assert.match(en('mem.conflict.notResident', { patch: 'k1' }), /^k1 — memory says/);
});

test('the answer cache key survives a question with spaces in it', () => {
  const key = answerCacheKey('f'.repeat(64), 'what is the WETH address?');
  assert.equal(key.slice(0, 64), 'f'.repeat(64));
  assert.equal(key.slice(65), 'what is the WETH address?');
});

test('decideRecall is a pure function of the index — the same inputs decide the same way with no home at all', () => {
  const ix = emptyIndex();
  fold(ix, { v: 1, at: 1, kind: 'learn', row_key: 'a?', answer: '1', source: 'bake', engram: 'self-baked-1', shape: 'sh' });
  fold(ix, { v: 1, at: 2, kind: 'apply', patch_id: 'self-baked-1', sha256: 'aaa', position: 0, stack_fp_after: 'fp' });
  const r = decideRecall(ix, 'a?', { stackFp: 'fp', hasModel: true, now: 3 });
  assert.equal(r.decision, 'confirm');
  assert.equal(r.engram, 'self-baked-1');
  assert.equal(existsSync(join(tmpdir(), 'no-home-was-touched')), false);
});

// ------------------------------------------------------------------ the wording somebody actually typed

test('a question is recallable in the wording it was ASKED, not only in the plan\'s wording', () => {
  // Measured before the fix (2026-09-07, throwaway node on 4193, local stdio MCP stand-in): the second ask of
  // "what is the contract address of USDC?" reported recall.decision "miss" and spent a second upstream query on a
  // fact already on disk, because `retrieve.ts` learns a row under `mapping.prompt` — a sentence in none of the
  // plan's own match patterns and one no person types.
  const m = AgentMemory.open(newHome());
  const canonical = 'What is the Ethereum mainnet contract address of the USD Coin (USDC) token?';
  m.learn([{ prompt: canonical, answer: '0xa0b8', source: 'retrieval', shape: 'sh' }]);
  assert.equal(m.recall('what is the contract address of USDC?', { stackFp: 'fp', hasModel: false }).decision, 'miss');

  m.learnAsked({ question: 'what is the contract address of USDC?', answer: '0xa0b8', canonical: rowKey(canonical), shape: 'sh' });
  const r = m.recall('what is the contract address of USDC?', { stackFp: 'fp', hasModel: false });
  assert.equal(r.decision, 'offline');
  assert.equal(r.answer, '0xa0b8');
  assert.equal(m.index.rows[rowKey('what is the contract address of USDC?')].alias_of, rowKey(canonical));
});

test('a second wording is not a second fact: an alias is recallable but is not material for a bake', () => {
  const m = AgentMemory.open(newHome());
  const canonical = 'What is the Ethereum mainnet contract address of the USD Coin (USDC) token?';
  m.learn([{ prompt: canonical, answer: '0xa0b8', source: 'retrieval', shape: 'sh' }]);
  m.learnAsked({ question: 'USDC contract address', answer: '0xa0b8', canonical: rowKey(canonical), shape: 'sh' });
  m.learnAsked({ question: 'USDC 컨트랙트 주소 알려줘', answer: '0xa0b8', canonical: rowKey(canonical), shape: 'sh' });
  m.recordRetrieve({ shape: 'sh', plan_id: 'p', arguments_sha256: 'a', rows: 1, new_rows: 1, refetched: 0, churned: 0, queries: 1, bytes: 10, ms: 5 });
  const v = memoryView(m, { shape: 'sh' });
  assert.equal(v.facts, 3);
  // …and exactly one of them is material. The lesson trains on the rows `retrieve.ts` wrote down, so a material gate
  // counting wordings would pass on 8 with 4 rows in the dataset.
  assert.equal(v.shapes[0].distinct_rows, 1);
});

test('a fact that moved takes its other wordings with it', () => {
  const m = AgentMemory.open(newHome());
  const canonical = 'What is the Ethereum mainnet contract address of the USD Coin (USDC) token?';
  m.learn([{ prompt: canonical, answer: '0xold', source: 'retrieval', shape: 'sh' }]);
  m.learnAsked({ question: 'USDC contract address', answer: '0xold', canonical: rowKey(canonical), shape: 'sh' });
  // the next retrieval of the same shape finds a different answer — the churn case
  m.learn([{ prompt: canonical, answer: '0xnew', source: 'retrieval', shape: 'sh' }]);
  assert.equal(m.recall('USDC contract address', { stackFp: 'fp', hasModel: false }).answer, '0xnew');
  // and it survives a replay from the log, because `fold` is the only place the index moves
  const replayed = AgentMemory.open(m.home, { now: () => Date.now() });
  rmSync(memoryIndexFile(m.home), { force: true });
  assert.equal(replayed.refresh().index.rows[rowKey('USDC contract address')].answer, '0xnew');
});

test('the asker\'s wording is not aliased to itself', () => {
  const m = AgentMemory.open(newHome());
  const q = 'What is the Ethereum mainnet contract address of the USD Coin (USDC) token?';
  m.learn([{ prompt: q, answer: '0xa0b8', source: 'retrieval', shape: 'sh' }]);
  assert.equal(m.learnAsked({ question: q, answer: '0xa0b8', canonical: rowKey(q), shape: 'sh' }), null);
  assert.equal(m.index.rows[rowKey(q)].alias_of, undefined);
  m.recordRetrieve({ shape: 'sh', plan_id: 'p', arguments_sha256: 'a', rows: 1, new_rows: 1, refetched: 0, churned: 0, queries: 1, bytes: 10, ms: 5 });
  assert.equal(memoryView(m, { shape: 'sh' }).shapes[0].distinct_rows, 1);
});
