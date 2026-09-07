/**
 * The bake decision: N* from this agent's own measurements, and the four gates.
 *
 * Nothing here trains anything. What is under test is the arithmetic that decides whether a lesson is worth
 * spending — the part that has to be right BEFORE a non-refundable lesson and a block of GPU time are committed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ETA_MIN_SAMPLES, ROWS_FLOOR_GRADIENT, bakeCosts, nStar, shouldBake } from '../src/bake.js';
import { memoryFile, type MemoryShapeView } from '../src/memory.js';

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
  ev({ shape: 'a'.repeat(64), dataset_id: 'd', dataset_sha256: null, job_id: 'j1', backend: 'stub', status: 'DONE', rows: 12, total_s: 3, npz_sha256: null });
  const costs = bakeCosts(h, 'a'.repeat(64));
  assert.deepEqual(costs.total_s, []);
  assert.deepEqual(costs.backends, ['stub']);
  assert.deepEqual(costs.jobs, ['j1']);
  const r = nStar(priced(), { home: h });
  assert.equal(r.computable, false);
  assert.ok(r.missing.some((m) => m.includes('stub lesson trains no weights')), r.missing.join(' | '));
});

test('a gradient lesson in the same log IS a price', () => {
  const h = home();
  const ev = (o: Record<string, unknown>) => appendFileSync(memoryFile(h), JSON.stringify({ v: 1, at: 1, kind: 'bake', ...o }) + '\n');
  ev({ shape: 'a'.repeat(64), job_id: 'j1', backend: 'stub', status: 'DONE', rows: 12, total_s: 3 });
  ev({ shape: 'a'.repeat(64), job_id: 'j2', backend: 'gradient', status: 'DONE', rows: 12, total_s: 60 });
  ev({ shape: 'b'.repeat(64), job_id: 'j3', backend: 'gradient', status: 'DONE', rows: 12, total_s: 900 });   // another shape
  ev({ shape: 'a'.repeat(64), job_id: 'j4', backend: 'gradient', status: 'FAILED', rows: 12, total_s: 5 });   // not DONE
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
