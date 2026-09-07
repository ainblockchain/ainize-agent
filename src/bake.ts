/**
 * The last step of the loop: the agent performs the product's own verb on itself.
 *
 * When a shape of question has been looked up often enough that retrieving it has already cost more than compiling
 * it once would, the agent builds a training set out of what it retrieved, spends a lesson on it, and keeps the
 * engram. Retrieval is a cost paid per question; compiled memory is a cost paid once. `graph/bench` measures the
 * static version of that claim; this is the dynamic one.
 *
 * Two rules shape everything here:
 *
 *  1. **The threshold is not a number we picked.** `graph/bench` owns the arithmetic — `N* = one-time cost / (cost
 *     per question retrieving − cost per question recalling)` — and run r1 leaves it UNCOMPUTED in writing because
 *     both arms must be scored and priced first (`graph/bench/runs/r1/summary.md:120-133`). Inventing a constant
 *     here would contradict the one document in this repo that refuses to. So N* is computed from this agent's own
 *     recorded measurements, and when it cannot be computed the agent does not bake and says which term is missing.
 *  2. **A lesson is scarce, non-refundable and burns GPU time.** The node charges one of `jobsPerKeyPerDay` at
 *     SUBMIT, before it even preflights, and never gives it back. So all four gates are checked before anything is
 *     reserved, and the lesson itself runs through `runTeachLesson` — the body of the MCP `teach` tool — rather than
 *     through a second copy of the pipeline.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { Context, loadConfig, runTeachLesson, type TeachLessonResult, type TeachPolicy } from '@ngram/mcp/client';
import { BudgetRefusal, trainerWorstCaseSeconds, type AgentBudget } from './budget.js';
import { agentLocale, translator, type Locale } from './i18n.js';
import { loadIdentity } from './identity.js';
import { memoryFile, type AgentMemory, type BakePayload, type MemoryEvent, type MemoryShapeView } from './memory.js';
import { datasetForShape, shapeFiles } from './retrieve.js';
import { LOOP_STRINGS } from './strings/loop.js';

/**
 * The smallest lesson this agent will spend a non-refundable lesson on: the node's own
 * `teach.rowsPerJob.floorGradient` (`packages/core/src/config.ts:88`).
 *
 * Stated precisely, because the neighbouring claim is wrong and easy to repeat: the node does NOT refuse a lesson
 * with fewer rows than this. `rowsPerJob` is a CEILING on how many questions one lesson may train
 * (`packages/node/src/teach.ts:1049`), and `floorGradient` is the value that ceiling falls back to while there are
 * too few timing samples to derive one. It is used here as a material floor because it is the node's own number for
 * "a lesson's worth of questions", and because a handful of facts is not a knowledge — not because a 400 would come
 * back.
 */
export const ROWS_FLOOR_GRADIENT = 8;

/**
 * The node's own rule before it will turn timings into an estimate (`packages/core/src/config.ts:173`, applied at
 * `:208`). Three stub jobs must never become an ETA, and three lookups must never become a break-even.
 */
export const ETA_MIN_SAMPLES = 3;

// ------------------------------------------------------------------------------------------------------ N*

export type NStarKind = 'seconds' | 'queries' | 'tokens';

/** One unit's arithmetic, with every term it was computed from — so a refusal can name what is missing. */
export interface NStarTerm {
  kind: NStarKind;
  unit: string;
  /** What compiling this shape costs once, in this unit. Null when nothing measured it. */
  bake_cost: number | null;
  /** What answering one question by retrieving costs, in this unit. */
  retrieval_cost: number | null;
  /** What answering one question by recalling costs, in this unit. */
  recall_cost: number | null;
  /** `bake_cost / (retrieval_cost − recall_cost)`, or null when that is not a number. */
  n_star: number | null;
  /** Why it is null, or what it means when it is not. Always set. */
  why: string;
}

export interface NStarResult {
  computable: boolean;
  /** The largest N\* over the units that have a measured price — the one the economic gate is held to. */
  n_star: number | null;
  binding: NStarKind | null;
  terms: NStarTerm[];
  /** Terms with no measurement, named in the refusal. Empty when `computable`. */
  missing: string[];
  measurements: { retrieval: number; recall: number; bake: number };
}

const mean = (sum: number, n: number): number | null => (n > 0 ? sum / n : null);
const round = (x: number, p = 2): number => Math.round(x * 10 ** p) / 10 ** p;

/**
 * What a bake of this shape has actually cost, read off the memory log rather than off the index.
 *
 * The index's `bake` counters do not carry the trainer backend, and a lesson run under `NGRAM_TEACH_BACKEND=stub`
 * copies a fixture npz: its `total_s` is a real measurement of a file copy and a meaningless price for training a
 * model. Using it as `bake_cost` would produce a confident N\* that measured nothing — the exact failure the node
 * guards against when it refuses to derive an ETA from stub samples.
 *
 * This reads `memory.jsonl` directly. That is deliberate and cheap: the log is an append-only public file the design
 * chose precisely so a second reader could `cat`, `grep` and `diff` it, and the event TYPES come from `memory.ts`,
 * so there is exactly one owner of the schema.
 */
export function bakeCosts(home: string, shape: string): { total_s: number[]; backends: string[]; jobs: string[] } {
  const file = memoryFile(home);
  const out = { total_s: [] as number[], backends: [] as string[], jobs: [] as string[] };
  if (!existsSync(file)) return out;
  let text = '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) { const n = readSync(fd, buf, read, size - read, read); if (n <= 0) break; read += n; }
    const lastNl = buf.subarray(0, read).lastIndexOf(0x0a);
    text = lastNl < 0 ? '' : buf.subarray(0, lastNl).toString('utf8');
  } finally { closeSync(fd); }
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('"bake"')) continue;
    let e: MemoryEvent;
    try { e = JSON.parse(line) as MemoryEvent; } catch { continue; }
    if (e.kind !== 'bake') continue;
    const b = e as BakePayload & { at: number };
    if (b.shape !== shape || b.status !== 'DONE') continue;
    if (b.job_id && !out.jobs.includes(b.job_id)) out.jobs.push(b.job_id);
    // A stub lesson trains no weights. Its seconds are the cost of copying a fixture, and they are not a price.
    if (b.backend === 'stub') { out.backends.push('stub'); continue; }
    out.backends.push(b.backend ?? 'unknown');
    if (typeof b.total_s === 'number' && b.total_s > 0) out.total_s.push(b.total_s);
  }
  return out;
}

/**
 * N\* per unit, and the one the decision is held to.
 *
 * Three units, and they do not convert into one another:
 *
 *  - **seconds** — the real break-even. A lookup takes wall-clock against somebody else's server; a recall takes a
 *    completion or nothing at all; a bake takes the trainer's measured `total_s`. All three are measured here.
 *  - **queries** — a retrieval spends an upstream query per question and a compiled memory spends none, so the
 *    break-even in queries is immediate. It is reported because it is true, and it never binds.
 *  - **tokens** — a retrieval spends no completion tokens and a recall does, so in this unit compiling is the more
 *    expensive of the two and there is no break-even at all. Reported, and deliberately excluded from the maximum:
 *    a term whose denominator is negative is not a threshold that a larger N would ever cross.
 */
export function nStar(s: MemoryShapeView, opts: { home?: string; bakeTotals?: number[] } = {}): NStarResult {
  const bakeTotals = opts.bakeTotals ?? (opts.home ? bakeCosts(opts.home, s.shape).total_s : []);
  const nRetr = s.retrieval.n, nRec = s.recall.n, nBake = bakeTotals.length;
  const measurements = { retrieval: nRetr, recall: nRec, bake: nBake };
  const missing: string[] = [];
  if (nRetr < ETA_MIN_SAMPLES) missing.push(`retrieval_cost: measurements ${nRetr} of ${ETA_MIN_SAMPLES}`);
  if (nRec < ETA_MIN_SAMPLES) missing.push(`recall_cost: measurements ${nRec} of ${ETA_MIN_SAMPLES}`);
  if (nBake < 1) missing.push('bake_cost: no lesson of this shape has finished on a real trainer (a stub lesson trains no weights, so its seconds are not a price)');

  const bakeS = mean(bakeTotals.reduce((a, b) => a + b, 0), nBake);
  const retrS = mean(s.retrieval.ms / 1000, nRetr);
  const recS = mean(s.recall.ms / 1000, nRec);
  const retrQ = mean(s.retrieval.queries, nRetr);
  const recTok = mean(s.recall.tokens, nRec);

  const terms: NStarTerm[] = [];
  const push = (kind: NStarKind, unit: string, bake: number | null, retr: number | null, rec: number | null): void => {
    if (bake === null || retr === null || rec === null) {
      terms.push({ kind, unit, bake_cost: bake, retrieval_cost: retr, recall_cost: rec, n_star: null, why: 'a term has never been measured' });
      return;
    }
    const saved = retr - rec;
    if (saved <= 0) {
      terms.push({
        kind, unit, bake_cost: round(bake, 3), retrieval_cost: round(retr, 3), recall_cost: round(rec, 3), n_star: null,
        why: `recalling costs ${round(rec, 3)} and retrieving costs ${round(retr, 3)} in this unit, so compiling saves nothing here and no number of lookups makes it pay`,
      });
      return;
    }
    terms.push({
      kind, unit, bake_cost: round(bake, 3), retrieval_cost: round(retr, 3), recall_cost: round(rec, 3),
      n_star: round(bake / saved, 2),
      why: `${round(bake, 3)} ${unit} once, against ${round(saved, 3)} ${unit} saved per question`,
    });
  };
  push('seconds', 'seconds', bakeS, retrS, recS);
  // A bake makes no upstream call: the rows it trains on are the ones already retrieved and already paid for.
  push('queries', 'upstream queries', nBake > 0 ? 0 : null, retrQ, 0);
  // A retrieval spends no completion tokens; a recall spends them. There is no break-even to cross in this unit.
  push('tokens', 'completion tokens', nBake > 0 ? 0 : null, 0, recTok);

  const usable = terms.filter((x): x is NStarTerm & { n_star: number } => x.n_star !== null);
  const binding = usable.length ? usable.reduce((a, b) => (b.n_star > a.n_star ? b : a)) : null;
  return {
    computable: missing.length === 0 && binding !== null,
    n_star: missing.length === 0 && binding ? binding.n_star : null,
    binding: missing.length === 0 && binding ? binding.kind : null,
    terms, missing, measurements,
  };
}

// ------------------------------------------------------------------------------------------------ the gates

export type GateName = 'economic' | 'material' | 'stability' | 'budget';

export interface BakeGate {
  name: GateName;
  ok: boolean;
  /** The numbers the verdict was reached from — never a bare pass/fail. */
  detail: Record<string, string | number | null>;
  /** The i18n key of the sentence for a failure, and the vars it needs. Null when the gate passed. */
  refusal: { key: string; vars: Record<string, string | number> } | null;
}

export interface BakePolicy {
  /**
   * A DECLARED floor: bake on the nth lookup of a shape whatever the arithmetic says. It is a policy the owner set,
   * it is labelled as one everywhere it appears, and it is never presented as a measurement.
   */
  bakeAfter?: number | null;
  /** Default 0: a fact that moved between two pulls is a fact the compiled copy would be wrong about. */
  maxChurn?: number;
  rowsFloor?: number;
}

/** Whether one reservation would fit in what is left today. G3's budget answers it; the gate only asks. */
export type BudgetProbe = (kind: 'lessons' | 'gpu_s', amount: number) => { ok: boolean; line: string };

export interface BakeDecision {
  shape: string;
  bake: boolean;
  /** `measured` — N\* was computed and crossed. `declared` — the owner's `--bake-after` floor was crossed. */
  trigger: 'measured' | 'declared' | null;
  gates: BakeGate[];
  nstar: NStarResult;
  /** The i18n key of the one sentence to print, and its vars. */
  say: { key: string; vars: Record<string, string | number> };
}

/**
 * All four gates, evaluated in full — the decision never short-circuits, so `agent memory --why` can print every
 * reason at once instead of the first one that happened to fail.
 */
export function shouldBake(s: MemoryShapeView, policy: BakePolicy = {}, opts: { home?: string; budget?: BudgetProbe; gpuSeconds?: number; bakeTotals?: number[] } = {}): BakeDecision {
  const maxChurn = policy.maxChurn ?? 0;
  const floor = policy.rowsFloor ?? ROWS_FLOOR_GRADIENT;
  const declared = policy.bakeAfter ?? null;
  const ns = nStar(s, { ...(opts.home ? { home: opts.home } : {}), ...(opts.bakeTotals ? { bakeTotals: opts.bakeTotals } : {}) });
  const short = s.shape.slice(0, 12);

  // ---- economic
  const measuredOk = ns.computable && ns.n_star !== null && s.lookups >= ns.n_star;
  const declaredOk = declared !== null && s.lookups >= declared;
  const economic: BakeGate = {
    name: 'economic',
    ok: measuredOk || declaredOk,
    detail: { lookups: s.lookups, n_star: ns.n_star, binding_unit: ns.binding, declared_floor: declared, computable: ns.computable ? 'yes' : 'no' },
    refusal: measuredOk || declaredOk ? null
      : ns.computable
        ? { key: 'bake.blocked.economic', vars: { shape: short, n: s.lookups, nstar: String(ns.n_star) } }
        : { key: 'bake.blocked.nstar', vars: { shape: short, missing: ns.missing.join('; ') } },
  };

  // ---- material
  const material: BakeGate = {
    name: 'material',
    ok: s.distinct_rows >= floor,
    detail: { distinct_rows: s.distinct_rows, floor },
    refusal: s.distinct_rows >= floor ? null : { key: 'bake.blocked.material', vars: { shape: short, rows: s.distinct_rows, floor } },
  };

  // ---- stability
  const churn = s.churn_rate ?? 0;
  const stability: BakeGate = {
    name: 'stability',
    ok: churn <= maxChurn,
    detail: { churn_rate: s.churn_rate, churned: s.churned, refetched: s.refetched, max_churn: maxChurn },
    refusal: churn <= maxChurn ? null : { key: 'bake.blocked.stability', vars: { shape: short, churn: String(churn), max: String(maxChurn) } },
  };

  // ---- budget. A lesson AND the trainer's worst case in GPU seconds both have to fit before anything is reserved.
  const gpu = opts.gpuSeconds ?? 0;
  const probes = opts.budget
    ? ([['lessons', 1], ['gpu_s', gpu]] as const).map(([kind, amount]) => ({ kind, amount, ...opts.budget!(kind, amount) }))
    : [];
  const overBudget = probes.find((p) => !p.ok);
  const budget: BakeGate = {
    name: 'budget',
    ok: !overBudget,
    detail: { lessons: 1, gpu_s: gpu, checked: probes.length },
    refusal: overBudget ? { key: 'bake.blocked.budget', vars: { shape: short, kind: overBudget.kind, detail: overBudget.line } } : null,
  };

  const gates = [economic, material, stability, budget];
  const failed = gates.find((g) => !g.ok);
  if (failed) return { shape: s.shape, bake: false, trigger: null, gates, nstar: ns, say: failed.refusal! };
  const trigger: 'measured' | 'declared' = measuredOk ? 'measured' : 'declared';
  return {
    shape: s.shape, bake: true, trigger, gates, nstar: ns,
    say: trigger === 'measured'
      ? { key: 'bake.trigger', vars: { n: s.lookups, shape: short, nstar: String(ns.n_star), samples: ns.measurements.retrieval + ns.measurements.recall + ns.measurements.bake } }
      : { key: 'bake.trigger.declared', vars: { n: s.lookups, shape: short, n_declared: String(declared), nstar_state: ns.computable ? `computed at ${ns.n_star}` : `not computable (${ns.missing.join('; ')})` } },
  };
}

// ------------------------------------------------------------------------------------------- spending the lesson

export interface RunBakeOptions {
  shape: string;
  market: string;
  home: string;
  memory: AgentMemory;
  budget: AgentBudget;
  /** The trainer's worst case in GPU seconds. The node does not publish it, so with neither this nor a policy that
   *  does, the bake refuses rather than holding a number nobody measured. */
  gpuSecondsPerLesson?: string | number;
  privateKey?: string;
  effort?: 'quick' | 'balanced' | 'thorough';
  locale?: Locale;
  log?: (line: string) => void;
  now?: () => number;
}

export interface BakeRun {
  shape: string;
  rows: number;
  job_id: string | null;
  dataset_id: string | null;
  backend: string | null;
  /** The node's own terminal status, not a word this side invented. */
  status: string;
  /** Wall clock from submit to a terminal state, MEASURED HERE. It is the agent's cost of compiling — queue time
   *  included — and it is not the trainer's `total_s`, which the node does not publish to a teaching key. */
  total_s: number | null;
  npz_sha256: string | null;
  lesson_spent: boolean;
  gpu_seconds_held: string | null;
  gpu_seconds_settled: string | null;
  /** True when the node ran `NGRAM_TEACH_BACKEND=stub`: a real lesson record over a knowledge file that trains nothing. */
  simulated: boolean;
  /** Whether the model was asked what it already knew, and why not when it was not. */
  preflight: 'ran' | 'skipped_no_model';
  /** The one command that publishes it. The loop never runs it. */
  publish_command: string;
  view: TeachLessonResult | null;
  error: string | null;
}

/**
 * Compile one shape into an engram, and keep it.
 *
 * Everything expensive is somebody else's code: the rows are the ones `retrieve.ts` already paid for and wrote down
 * (`datasetForShape`), the lesson is `runTeachLesson` — the body of the MCP `teach` tool — and the money-shaped
 * scarcity is `AgentBudget`. What is here is the accounting between them: hold a lesson and a block of GPU seconds
 * before anything is submitted, settle them with what it actually took, write the `bake` event at submit AND at the
 * terminal state, and never publish.
 */
export async function runBake(o: RunBakeOptions): Promise<BakeRun> {
  const locale = o.locale ?? agentLocale();
  const t = translator(LOOP_STRINGS, locale);
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const short = o.shape.slice(0, 12);
  const identity = loadIdentity(o.home, o.privateKey);

  const ds = datasetForShape(o.home, o.shape);
  if (!ds.rows.length) {
    log(t('bake.blocked.noRows', { shape: short }));
    return {
      shape: o.shape, rows: 0, job_id: null, dataset_id: null, backend: null, status: 'NOT_SUBMITTED', total_s: null,
      npz_sha256: null, lesson_spent: false, gpu_seconds_held: null, gpu_seconds_settled: null, simulated: false,
      preflight: 'ran', publish_command: '', view: null, error: 'no rows retrieved for this shape',
    };
  }
  if (ds.unreadable) log(`${ds.unreadable} line(s) of the retrieved rows file were not readable and were left out`);

  // The teaching key IS this agent's identity: its lessons and its purchases share one address on a public record.
  // Deliberate — lineage needs it — and said out loud before the first lesson.
  log(t('bake.identityWarning', { address: identity.address }));
  const cfg = loadConfig({
    env: {
      AINIZE_NODE_URL: o.market,
      AINIZE_TEACH_KEY: identity.privateKey,
      AINIZE_MCP_MAX_TEACH_JOBS: '1',
      AINIZE_MCP_STATE_DIR: o.home,
      AINIZE_MCP_POLL_MS: process.env.NGRAM_AGENT_POLL_MS ?? '3000',
    } as NodeJS.ProcessEnv,
  });
  const ctx = new Context(cfg);

  const policy = (await ctx.teachPolicy().catch(() => null)) as TeachPolicy | null;
  /*
   * The preflight asks the SERVING MODEL what it already answers, so that a scarce lesson is not spent teaching
   * something the model knows. On a node with no serving model there is nothing to ask, and the node refuses the
   * call outright ("runtime unavailable") — which used to take the whole bake down with it.
   *
   * So it is skipped exactly when the node itself says it has no model, and never otherwise. This is not a
   * fallback and not a default: it is printed, it is recorded on the run, and the risk it drops (a lesson spent on
   * a fact the model already had) is named where the owner can read it.
   */
  const info = await ctx.nodeInfo().catch(() => null);
  const noModel = info ? !info.runtime_available : false;
  if (noModel) log('the node reports no serving model, so the preflight cannot run — the lesson is submitted without asking what the model already knows, and it still costs one of today\'s lessons');
  const backend = policy?.backend ?? null;
  if (backend === 'stub') log(t('bake.stub'));
  // The node's own per-key daily limit is a SECOND ceiling and the tighter of the two wins.
  const nodeLimit = policy?.limits?.jobs_per_key_per_day;
  if (typeof nodeLimit === 'number') o.budget.applyNodeLessonLimit(nodeLimit, `${o.market} GET /api/teach/policy`);

  /*
   * How many GPU seconds to hold.
   *
   * A `stub` lesson copies a fixture npz and never starts a trainer, so the honest hold is zero — and the run says
   * so, because a zero that means "no GPU was used" must not be read as "nobody looked".
   *
   * On a real trainer the number is `teach.trainer.timeoutMs / 1000`, the worst case the node itself allows. The
   * node does NOT publish it (`GET /api/teach/policy` carries no trainer timeout), so with neither that nor
   * `--gpu-seconds-per-lesson` there is no number to hold, and a bake that held zero would be claiming a
   * measurement nobody made. It refuses instead, and names the flag.
   */
  const worst = trainerWorstCaseSeconds(policy, o.gpuSecondsPerLesson);
  if (!worst && backend !== 'stub') {
    const why = `this node runs the ${backend ?? 'unknown'} trainer and does not publish its timeout (GET /api/teach/policy has no limits.trainer_timeout_s), so there is no worst case to hold against the GPU-second budget. Give it with --gpu-seconds-per-lesson <s>. Nothing was spent.`;
    log(why);
    return {
      shape: o.shape, rows: ds.rows.length, job_id: null, dataset_id: null, backend, status: 'NOT_SUBMITTED',
      total_s: null, npz_sha256: null, lesson_spent: false, gpu_seconds_held: null, gpu_seconds_settled: null,
      simulated: false, preflight: 'ran', publish_command: '', view: null, error: why,
    };
  }
  const gpuSeconds = worst?.seconds ?? '0';
  if (!worst) log('the stub backend starts no trainer, so this lesson holds 0 GPU seconds — a measured zero, not an unknown');

  // Hold both before anything is submitted. A refusal here has cost nothing at all.
  const lessonHold = o.budget.reserve({ kind: 'lessons', amount: 1, act: 'teach_job', ref: short, market: o.market });
  let gpuHold;
  try {
    gpuHold = o.budget.reserve({ kind: 'gpu_s', amount: gpuSeconds, act: 'teach_gpu', ref: short, market: o.market });
  } catch (e) {
    lessonHold.release('the GPU-second budget refused the lesson, so nothing was submitted');
    throw e;
  }

  const provFile = shapeFiles(o.home, o.shape).provenance;
  let provenance: Record<string, unknown> | undefined;
  try { provenance = JSON.parse(readFileSync(provFile, 'utf8')) as Record<string, unknown>; } catch { provenance = undefined; }

  log(t('bake.submitting', { shape: short, rows: ds.rows.length, market: o.market, backend: backend ?? 'unknown', gpu_s: gpuSeconds }));
  const t0 = now();
  let jobId: string | null = null;
  let datasetId: string | null = null;
  let submitted = false;
  const controller = new AbortController();
  try {
    const view = await runTeachLesson(ctx, {
      rows: ds.rows,
      name: `ainized ${short}`,
      retention: 'keep',
      effort: o.effort ?? 'balanced',
      ...(noModel ? { skip_preflight: true } : {}),
      ...(provenance ? { provenance } : {}),
    }, {
      signal: controller.signal,
      onState: (ev) => {
        if (!submitted) {
          submitted = true;
          jobId = ev.teach_job_id;
          // The lesson exists on the node from here on. Written down BEFORE the poll loop, so a crash mid-training
          // still leaves a handle rather than a lesson nobody can find.
          o.memory.recordBake({ shape: o.shape, dataset_id: null, dataset_sha256: null, job_id: ev.teach_job_id, backend, status: ev.status, rows: ds.rows.length, total_s: null, npz_sha256: null });
          log(t('bake.submitted', { job: ev.teach_job_id, dataset: datasetId ?? '(pending)', state: ev.status }));
        }
      },
    });
    const total_s = Math.round((now() - t0) / 100) / 10;
    jobId = view.node_job_id;
    datasetId = (view.training_set ? String((view.training_set as { id?: unknown }).id ?? '') : '') || null;
    const simulated = !!view.checks?.simulated;
    /*
     * GPU seconds are settled with what the GPU actually did, and on a stub lesson that is zero: it copies a
     * fixture and starts no trainer. Settling the wall clock there would have written 6.2 GPU seconds against a
     * budget for a run that used none — a number nothing measured.
     *
     * On a real trainer the node does not report the trainer's own seconds to a teaching key (`teach_stats` is
     * operator-side), so the wall clock from submit to a terminal state is settled instead. It is an UPPER bound —
     * it includes queue time — and it is labelled as one wherever it is written down.
     */
    const gpuUsed = backend === 'stub' ? 0 : total_s;
    const settledGpu = gpuHold.settle(gpuUsed, backend === 'stub'
      ? `the stub backend started no trainer for lesson ${view.node_job_id}`
      : `wall clock of lesson ${view.node_job_id}, queue included — the node does not report trainer seconds to a teaching key`);
    lessonHold.settle(1, `lesson ${view.node_job_id} ended ${view.native_state}`);
    o.memory.recordBake({
      shape: o.shape, dataset_id: datasetId, dataset_sha256: null, job_id: view.node_job_id, backend,
      status: view.native_state, rows: ds.rows.length, total_s, npz_sha256: view.knowledge_file?.sha256 ?? null,
      ...(view.draft_id ? { patch_id: view.draft_id } : {}),
    });
    const publish = `ainize teach publish ${view.node_job_id} --name "<name>" --price <n> --consent-permanent --consent-rights`;
    log(t('bake.done', { job: view.node_job_id, state: view.native_state, total_s: String(total_s) }));
    log(t('bake.autoNeverPublishes', { command: publish }));
    return {
      shape: o.shape, rows: ds.rows.length, job_id: view.node_job_id, dataset_id: datasetId, backend,
      status: view.native_state, total_s, npz_sha256: view.knowledge_file?.sha256 ?? null,
      lesson_spent: true, gpu_seconds_held: gpuSeconds, gpu_seconds_settled: settledGpu, simulated,
      preflight: noModel ? 'skipped_no_model' : 'ran',
      publish_command: publish, view, error: null,
    };
  } catch (e) {
    const total_s = Math.round((now() - t0) / 100) / 10;
    const msg = (e as Error).message;
    if (e instanceof BudgetRefusal) { lessonHold.release(msg); gpuHold.release(msg); throw e; }
    if (!submitted) {
      // The node never queued it — nothing was spent, so nothing is settled. This is the same refund
      // `runTeachLesson` makes to the MCP server's own session cap.
      lessonHold.release(`the node never queued the lesson: ${msg}`);
      gpuHold.release(`the node never queued the lesson: ${msg}`);
      log(`the lesson was not submitted (${msg}) — no lesson and no GPU second were spent`);
    } else {
      // It WAS queued: the node charges at submit and does not refund, so this side does not pretend otherwise.
      lessonHold.settle(1, `lesson ${jobId ?? '?'} failed after it was queued`);
      gpuHold.settle(backend === 'stub' ? 0 : total_s, `lesson ${jobId ?? '?'} failed after ${total_s} s of wall clock`);
      o.memory.recordBake({ shape: o.shape, dataset_id: datasetId, dataset_sha256: null, job_id: jobId, backend, status: 'FAILED', rows: ds.rows.length, total_s, npz_sha256: null });
      log(t('bake.failed', { state: 'FAILED', reason: msg }));
    }
    return {
      shape: o.shape, rows: ds.rows.length, job_id: jobId, dataset_id: datasetId, backend,
      status: submitted ? 'FAILED' : 'NOT_SUBMITTED', total_s: submitted ? total_s : null, npz_sha256: null,
      lesson_spent: submitted, gpu_seconds_held: gpuSeconds, gpu_seconds_settled: submitted ? String(backend === 'stub' ? 0 : total_s) : null,
      simulated: backend === 'stub', preflight: noModel ? 'skipped_no_model' : 'ran', publish_command: '', view: null, error: msg,
    };
  }
}
