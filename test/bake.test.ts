/**
 * The bake decision: N* from this agent's own measurements, and the four gates.
 *
 * Nothing here trains anything. What is under test is the arithmetic that decides whether a lesson is worth
 * spending — the part that has to be right BEFORE a non-refundable lesson and a block of GPU time are committed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BAKE_DONE_STATUSES, ETA_MIN_SAMPLES, ROWS_FLOOR_GRADIENT, bakeCosts, nStar, provenanceSentence, publishCommand, shouldBake } from '../src/bake.js';
import { provenanceForShape, shapeFiles } from '../src/retrieve.js';
import { LOOP_STRINGS } from '../src/strings/loop.js';
import { LESSON_TERMINAL, emptyIndex, fold, memoryFile, type MemoryShapeView } from '../src/memory.js';

const homes: string[] = [];
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'ainize-bake-')); homes.push(h); return h; };
test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** A shape with whatever counters the case needs; everything else is zero, as a fresh shape really is. */
function shape(o: Partial<MemoryShapeView> = {}): MemoryShapeView {
  const base: MemoryShapeView = {
    shape: 'a'.repeat(64), plan_id: 'graph/erc20', lookups: 0, recalls: 0, recall_hits: 0,
    new_rows: 0, refetched: 0, churned: 0, first_at: 1, last_at: 2,
    retrieval: { n: 0, ms: 0, queries: 0, bytes: 0, rows: 0 },
    recall: { n: 0, ms: 0, tokens: 0 },
    bake: { n: 0, total_s: 0, jobs: [] },
    distinct_rows: 0, churn_rate: null,
    measurements: { retrieval: 0, recall: 0, bake: 0 },
    per_lookup: null, per_recall: null, line: '',
  };
  return { ...base, ...o };
}

/** Priced the way a real shape gets priced: 4 lookups at 2 s and one query each, 4 recalls at 40 ms. */
const priced = (over: Partial<MemoryShapeView> = {}): MemoryShapeView => shape({
  lookups: 4, distinct_rows: 12, new_rows: 12,
  retrieval: { n: 4, ms: 8_000, queries: 4, bytes: 40_000, rows: 48 },
  recall: { n: 4, ms: 160, tokens: 48 },
  ...over,
});

test('N* is not computable before the node has measured both sides — and it names the term it is short of', () => {
  const r = nStar(priced({ lookups: 2, retrieval: { n: 2, ms: 4000, queries: 2, bytes: 2, rows: 2 } }), { bakeTotals: [] });
  assert.equal(r.computable, false);
  assert.equal(r.n_star, null);
  assert.ok(r.missing.some((m) => m.startsWith('retrieval_cost')), r.missing.join(' | '));
  assert.ok(r.missing.some((m) => m.startsWith('bake_cost')), r.missing.join(' | '));
  assert.equal(ETA_MIN_SAMPLES, 3);
});

test('with both sides measured and one finished lesson, N* is the seconds break-even', () => {
  // retrieval 2.000 s/question, recall 0.040 s/question, a bake that took 60 s → 60 / 1.96 = 30.61
  const r = nStar(priced(), { bakeTotals: [60] });
  assert.equal(r.computable, true);
  assert.equal(r.binding, 'seconds');
  assert.equal(r.n_star, 30.61);
  const secs = r.terms.find((x) => x.kind === 'seconds')!;
  assert.equal(secs.retrieval_cost, 2);
  assert.equal(secs.recall_cost, 0.04);
});

test('the token term is reported and never binds — compiling does not save completion tokens', () => {
  const r = nStar(priced(), { bakeTotals: [60] });
  const tok = r.terms.find((x) => x.kind === 'tokens')!;
  assert.equal(tok.n_star, null);
  assert.match(tok.why, /compiling saves nothing here/);
  // queries: a bake makes no upstream call, so the break-even in queries is immediate — true, and it never binds
  assert.equal(r.terms.find((x) => x.kind === 'queries')!.n_star, 0);
  assert.equal(r.binding, 'seconds');
});

test('a stub lesson is not a price: its seconds are excluded and bake_cost stays missing', () => {
  const h = home();
  const ev = (o: Record<string, unknown>) => appendFileSync(memoryFile(h), JSON.stringify({ v: 1, at: 1, kind: 'bake', ...o }) + '\n');
  ev({ shape: 'a'.repeat(64), dataset_id: 'd', dataset_sha256: null, job_id: 'j1', backend: 'stub', status: 'READY', rows: 12, total_s: 3, npz_sha256: null });
  const costs = bakeCosts(h, 'a'.repeat(64));
  assert.deepEqual(costs.total_s, []);
  assert.deepEqual(costs.backends, ['stub']);
  assert.deepEqual(costs.jobs, ['j1']);
  const r = nStar(priced(), { home: h });
  assert.equal(r.computable, false);
  assert.ok(r.missing.some((m) => m.includes('stub lesson trains no weights')), r.missing.join(' | '));
});

test('the statuses that count as a finished lesson are the node\'s own, and they do not drift', async () => {
  // The node's terminal success status is READY, never "DONE" — `DONE` is the teach VIEW's word for it. Keying on
  // the view's word meant `bake_cost` was never found, N* was never computable, and the economic gate could never
  // be satisfied however many lessons had run.
  const { TEACH_TERMINAL, teachState } = await import('@ngram/mcp/client');
  const done = TEACH_TERMINAL.filter((s) => teachState(s) === 'done');
  assert.deepEqual([...BAKE_DONE_STATUSES].sort(), [...done].sort());
  assert.ok(BAKE_DONE_STATUSES.includes('READY' as never));
  assert.ok(!(BAKE_DONE_STATUSES as readonly string[]).includes('FAILED'));
  // …and memory's own list is the node's whole terminal set: a FAILED lesson finished, and the shape's counter has
  // to say so even though its seconds are not a price.
  assert.deepEqual([...LESSON_TERMINAL].sort(), [...TEACH_TERMINAL].sort());
  for (const s of BAKE_DONE_STATUSES) assert.ok((LESSON_TERMINAL as readonly string[]).includes(s), `${s} is a success but not terminal`);
});

test('a lesson that finished increments the shape\'s bake counter — READY is the node\'s word, not DONE', () => {
  // Measured 2026-09-07: a baked engram sat in memory as `held` while the shape it came from reported `bakes 0`,
  // because `fold` keyed on 'DONE', which the node never writes.
  const ix = emptyIndex();
  fold(ix, { v: 1, at: 1, kind: 'bake', shape: 'sh', dataset_id: null, dataset_sha256: null, job_id: 'j1', backend: 'stub', status: 'QUEUED', rows: 8, total_s: null, npz_sha256: null });
  assert.equal(ix.shapes.sh.bake.n, 0, 'a queued lesson has not finished');
  fold(ix, { v: 1, at: 2, kind: 'bake', shape: 'sh', dataset_id: 'd', dataset_sha256: null, job_id: 'j1', backend: 'stub', status: 'READY', rows: 8, total_s: 6.1, npz_sha256: 'x' });
  assert.equal(ix.shapes.sh.bake.n, 1);
  assert.equal(ix.shapes.sh.bake.total_s, 6.1);
  assert.deepEqual(ix.shapes.sh.bake.jobs, ['j1']);
  fold(ix, { v: 1, at: 3, kind: 'bake', shape: 'sh', dataset_id: 'd', dataset_sha256: null, job_id: 'j2', backend: 'gradient', status: 'FAILED', rows: 8, total_s: 4, npz_sha256: null });
  assert.equal(ix.shapes.sh.bake.n, 2, 'a failed lesson finished too');
});

test('a gradient lesson in the same log IS a price', () => {
  const h = home();
  const ev = (o: Record<string, unknown>) => appendFileSync(memoryFile(h), JSON.stringify({ v: 1, at: 1, kind: 'bake', ...o }) + '\n');
  ev({ shape: 'a'.repeat(64), job_id: 'j1', backend: 'stub', status: 'READY', rows: 12, total_s: 3 });
  ev({ shape: 'a'.repeat(64), job_id: 'j2', backend: 'gradient', status: 'READY', rows: 12, total_s: 60 });
  ev({ shape: 'b'.repeat(64), job_id: 'j3', backend: 'gradient', status: 'READY', rows: 12, total_s: 900 });   // another shape
  ev({ shape: 'a'.repeat(64), job_id: 'j4', backend: 'gradient', status: 'FAILED', rows: 12, total_s: 5 });    // produced nothing
  ev({ shape: 'a'.repeat(64), job_id: 'j5', backend: 'gradient', status: 'QUEUED', rows: 12, total_s: null });  // not terminal
  assert.deepEqual(bakeCosts(h, 'a'.repeat(64)).total_s, [60]);
  assert.equal(nStar(priced(), { home: h }).n_star, 30.61);
});

test('no bake below the material floor, and the floor is the node\'s own number', () => {
  assert.equal(ROWS_FLOOR_GRADIENT, 8);
  const d = shouldBake(priced({ distinct_rows: 7 }), { bakeAfter: 1 }, { bakeTotals: [60] });
  assert.equal(d.bake, false);
  assert.equal(d.say.key, 'bake.blocked.material');
  assert.equal(d.gates.find((g) => g.name === 'material')!.detail.floor, 8);
  assert.equal(shouldBake(priced({ distinct_rows: 8 }), { bakeAfter: 1 }, { bakeTotals: [60] }).bake, true);
});

test('a fact that moved stops the bake — churn defaults to zero tolerance', () => {
  const churned = priced({ refetched: 4, churned: 1, churn_rate: 0.25 });
  const d = shouldBake(churned, { bakeAfter: 1 }, { bakeTotals: [60] });
  assert.equal(d.bake, false);
  assert.equal(d.say.key, 'bake.blocked.stability');
  assert.equal(d.gates.find((g) => g.name === 'stability')!.detail.churned, 1);
  // …and an owner who accepts some churn says so
  assert.equal(shouldBake(churned, { bakeAfter: 1, maxChurn: 0.5 }, { bakeTotals: [60] }).bake, true);
});

test('with no computable N* and no declared floor, the agent does not bake and says which term is missing', () => {
  const d = shouldBake(priced(), {}, { bakeTotals: [] });
  assert.equal(d.bake, false);
  assert.equal(d.trigger, null);
  assert.equal(d.say.key, 'bake.blocked.nstar');
  assert.match(String(d.say.vars.missing), /bake_cost/);
});

test('--bake-after is a POLICY, labelled as one, and never presented as a measurement', () => {
  const d = shouldBake(priced({ lookups: 3 }), { bakeAfter: 3 }, { bakeTotals: [] });
  assert.equal(d.bake, true);
  assert.equal(d.trigger, 'declared');
  assert.equal(d.say.key, 'bake.trigger.declared');
  assert.match(String(d.say.vars.nstar_state), /not computable/);
  // one lookup short of the declared floor is still a refusal
  assert.equal(shouldBake(priced({ lookups: 2 }), { bakeAfter: 3 }, { bakeTotals: [] }).bake, false);
});

test('a measured trigger fires only once lookups reach N*, and reports which unit bound it', () => {
  assert.equal(shouldBake(priced({ lookups: 30 }), {}, { bakeTotals: [60] }).bake, false);   // N* = 30.61
  const d = shouldBake(priced({ lookups: 31 }), {}, { bakeTotals: [60] });
  assert.equal(d.bake, true);
  assert.equal(d.trigger, 'measured');
  assert.equal(d.say.key, 'bake.trigger');
  assert.equal(d.gates.find((g) => g.name === 'economic')!.detail.binding_unit, 'seconds');
});

test('the budget is the last gate and refuses with the budget\'s own sentence', () => {
  const seen: [string, number][] = [];
  const d = shouldBake(priced(), { bakeAfter: 1 }, {
    bakeTotals: [60], gpuSeconds: 1800,
    budget: (kind, amount) => { seen.push([kind, amount]); return kind === 'gpu_s' ? { ok: false, line: 'GPU seconds: 1800 needed, 0 left' } : { ok: true, line: '' }; },
  });
  assert.equal(d.bake, false);
  assert.equal(d.say.key, 'bake.blocked.budget');
  assert.equal(d.say.vars.kind, 'gpu_s');
  assert.match(String(d.say.vars.detail), /1800 needed/);
  assert.deepEqual(seen, [['lessons', 1], ['gpu_s', 1800]]);
});

test('every gate is evaluated, so one command can print every reason at once', () => {
  const d = shouldBake(shape({ lookups: 1, distinct_rows: 2, refetched: 2, churned: 2, churn_rate: 1 }), {}, { bakeTotals: [] });
  assert.equal(d.bake, false);
  assert.equal(d.gates.length, 4);
  assert.deepEqual(d.gates.map((g) => [g.name, g.ok]), [['economic', false], ['material', false], ['stability', false], ['budget', true]]);
  for (const g of d.gates) if (!g.ok) assert.ok(g.refusal, `${g.name} failed with no sentence`);
});

// ------------------------------------------------------------------ where the rows came from

const SHAPE = 'e'.repeat(64);

/** Two calls of one shape, as `retrieve.ts` really appends them: one JSON object per LINE. */
function twoCalls(h: string, secondBlock = 20000000): void {
  const f = shapeFiles(h, SHAPE).provenance;
  mkdirSync(join(h, 'retrieved'), { recursive: true });
  const rec = (symbol: string, block: number, at: number) => JSON.stringify({
    plan_id: 'graph/erc20-address-by-symbol', slots: { symbol }, at, shape: SHAPE,
    provenance: {
      source: 'mcp', server: { name: 'subgraph-mcp', transport: 'sse', authenticated: true }, tool: 'execute_query_by_subgraph_id',
      arguments: { symbol }, arguments_sha256: `${symbol}-args`, fetched_at: at,
      upstream: { subgraph_id: '5zvR82', network: 'ethereum', block },
      row_hashes: ['h'], rows_sha256: `${symbol}-rows`, rows: 1,
    },
  }) + '\n';
  appendFileSync(f, rec('USDC', 20000000, Date.UTC(2026, 8, 7, 3)));
  appendFileSync(f, rec('WETH', secondBlock, Date.UTC(2026, 8, 8, 3)));
}

test('the provenance of a lesson is read a LINE at a time — a whole-file JSON.parse dropped it for every bakeable shape', () => {
  const h = home();
  twoCalls(h);
  // What the code used to do, and what it did on a real 8-call shape on 2026-09-07:
  assert.throws(() => JSON.parse(require('node:fs').readFileSync(shapeFiles(h, SHAPE).provenance, 'utf8')));
  const p = provenanceForShape(h, SHAPE)!;
  assert.equal(p.calls, 2);
  assert.equal(p.rows, 2);
  assert.equal(p.plan_id, 'graph/erc20-address-by-symbol');
  assert.equal(p.tool, 'execute_query_by_subgraph_id');
  assert.equal(p.retrievals.length, 2);
  assert.equal(p.unreadable, 0);
});

test('a pin two calls disagreed about is dropped, not averaged — a lesson made at two blocks was made at neither', () => {
  const h = home();
  twoCalls(h, 20000999);
  const p = provenanceForShape(h, SHAPE)!;
  assert.equal(p.upstream.subgraph_id, '5zvR82');
  assert.equal(p.upstream.network, 'ethereum');
  assert.equal(p.upstream.block, undefined);
  assert.deepEqual(p.upstream_varied, ['block']);
  assert.match(provenanceSentence(p, 'en'), /varied across calls: block/);
});

test('the publish command a person is handed declares where the questions came from', () => {
  const h = home();
  twoCalls(h);
  const p = provenanceForShape(h, SHAPE)!;
  const cmd = publishCommand('job-1', p, 'en');
  // authenticated: somebody's key opened that connection, so the rows are licensed to this agent, not its own work
  assert.match(cmd, / --declare licensed /);
  assert.match(cmd, / --access derivative /);
  assert.match(cmd, /--description "2 facts retrieved by an Ainize agent from subgraph-mcp/);
  assert.match(cmd, /subgraph_id 5zvR82/);
  assert.match(cmd, /--consent-permanent --consent-rights$/);
  // an anonymous connection is a public source, and it is a measured difference rather than a judgement
  p.server!.authenticated = false;
  assert.match(publishCommand('job-1', p, 'en'), / --declare public /);
  // with nothing measured there is nothing to declare, and the command says nothing rather than guessing
  assert.equal(publishCommand('job-1', undefined, 'en'), 'ainize teach publish job-1 --name "<name>" --price <n> --consent-permanent --consent-rights');
});

test('the description a buyer will read exists in both languages, with the same values in each', () => {
  const h = home();
  twoCalls(h);
  const p = provenanceForShape(h, SHAPE)!;
  const en = provenanceSentence(p, 'en');
  const ko = provenanceSentence(p, 'ko');
  assert.match(ko, /[가-힣]/);
  assert.doesNotMatch(ko, /retrieved by an Ainize agent/);
  for (const s of [en, ko]) {
    assert.match(s, /subgraph-mcp/);
    assert.match(s, /5zvR82/);
    assert.match(s, /\b2\b/);
  }
  for (const key of ['bake.provenance.description', 'bake.provenance.on', 'bake.provenance.between', 'bake.provenance.varied'] as const) {
    const e = LOOP_STRINGS[key];
    const slots = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(slots(e.ko), slots(e.en), `${key}'s two languages interpolate different values`);
    assert.match(e.ko, /[가-힣]/, `${key}'s Korean is not written in Korean`);
  }
});

test('a shell metacharacter in a description cannot break out of the command', () => {
  const h = home();
  const f = shapeFiles(h, SHAPE).provenance;
  mkdirSync(join(h, 'retrieved'), { recursive: true });
  appendFileSync(f, JSON.stringify({
    plan_id: 'p', slots: {}, at: 1, shape: SHAPE,
    provenance: {
      source: 'mcp', server: { name: 'evil"; rm -rf /; echo "', transport: 'sse', authenticated: false },
      tool: 't', arguments: {}, arguments_sha256: 'a', fetched_at: 1, upstream: {}, row_hashes: [], rows_sha256: 'r', rows: 1,
    },
  }) + '\n');
  const cmd = publishCommand('job-1', provenanceForShape(h, SHAPE)!, 'en');
  const desc = /--description "((?:[^"\\]|\\.)*)"/.exec(cmd);
  assert.ok(desc, `no quoted description in: ${cmd}`);
  assert.match(cmd, /\\"; rm -rf \/; echo \\"/);
  assert.equal(cmd.split('--consent-permanent').length, 2);
});
