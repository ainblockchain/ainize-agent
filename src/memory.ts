/**
 * The agent's memory — what it knows, what it owns, what it looked up, and what the model actually has on it.
 * (docs/agent-memory-design.md §2–§4; G1.)
 *
 * The agent buys a knowledge, verifies it, applies it into a running model — and then writes down nothing. Its whole
 * durable state is `identity.json`, `purchases.jsonl` and `pending-payments.jsonl`: not one question, answer, lookup
 * or fact. Every run therefore starts from zero and re-derives everything from the catalog and a probe of a shared
 * model. This module is the missing half.
 *
 * TWO COPIES, ONE AUTHORITY EACH, AND NEITHER IS EVER EDITED TO MATCH THE OTHER (§2):
 *
 *   <NGRAM_AGENT_HOME>/memory.jsonl        authority on what THIS AGENT knows, owns, retrieved, paid and baked
 *   GET <market>/api/runtime               authority on what is ON THE MODEL right now
 *
 * The agent is explicitly not the node's operator (`agent.ts:675`), it may talk to several markets, and it must work
 * with no runtime at all — so the node's table cannot be its only memory. And a memory that says "loaded" is a claim,
 * not evidence: the model is shared, and another tenant can apply or remove a layer between two runs — so the agent's
 * own file cannot be the only truth about the model either. When they disagree, `reconcile()` writes a `conflict`
 * event carrying BOTH sides and demotes; it never silently rewrites one copy to match the other.
 *
 * WHY AN APPEND-ONLY LOG rather than SQLite: the agent's existing crash-safety story is exactly this shape
 * (`pending-payments.jsonl` is written before the money moves), the volume is bounded by the budget, and a memory you
 * can `cat`, `grep`, `diff` and copy to another machine is worth more here than an index. `memory-index.json` is a
 * DERIVED snapshot written tmp+rename (the `PurchaseJournal.flush` pattern) that records the byte offset it was built
 * through — deleting it costs a replay, never a fact.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { translator } from './i18n.js';
import { MEMORY_STRINGS } from './strings/memory.js';

/** The locale is read per call, not at import time, so a long-lived process picks up a changed environment. */
const t = (key: string, vars?: Record<string, string | number>): string => translator(MEMORY_STRINGS)(key, vars);

export const MEMORY_V = 1;

/**
 * How long an answer stays usable in the cache keyed by `(stack_fp, row_key)`.
 *
 * The fingerprint already invalidates on every change to the MODEL. Time is the only guard against a change in the
 * WORLD — a fact that moved while the model stayed the same — so the window is one day, the boundary the rest of the
 * agent already counts in (`spentToday`, the per-day budgets).
 */
export const ANSWER_TTL_MS = 24 * 60 * 60_000;
/** The snapshot is a cache, not a record: the newest N answers are kept and the rest are dropped on save. */
export const ANSWER_CACHE_MAX = 2000;
/** `GET /api/runtime` is cheap and public, but not free: one read per 5 s of wall clock is enough for a decision. */
export const RUNTIME_CACHE_MS = 5_000;

// ---------------------------------------------------------------------------------------------- the question key

/**
 * The node's own question key, character for character.
 *
 * Copied here for the same reason `packages/mcp/src/rows.ts` copies it out of the node: `@ngram/node`'s entry point
 * pulls express, sqlite and the trainer into a process that has 200 ms to answer. `test/memory.test.ts` pins this
 * copy to `packages/mcp/src/rows.ts`, which is itself pinned to `packages/node/src/teach-dataset.ts` — so a fact
 * learned from a training set and a question typed by a person land on the SAME key, which is the only reason the
 * row index and the node's de-duplication agree. When G2's subpath export lands this file imports `promptKey` from
 * `@ngram/mcp/rows` and the pin test proves nothing moved.
 */
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clean = (s: string): string => collapse(String(s).normalize('NFC').replace(CONTROLS, ''));

/** `promptKey({prompt, answer})` of the node's dataset parser, taking the question alone. */
export function rowKey(prompt: string): string {
  const p = clean(prompt);
  // the node unwraps a benchmark rendering ("Q: …\nA:") rather than keying on the literal text
  const qa = p.match(/^Q\s*:\s*(.*?)\s*(?:A\s*:\s*)?$/i);
  return qa && qa[1] && /^Q\s*:/i.test(p) ? qa[1] : p;
}

/** The node's answer normalisation: NFC, invisibles stripped, every kind of whitespace flattened to one space. */
export const normalizeAnswer = (s: string): string => collapse(String(s).normalize('NFC').replace(CONTROLS, '').replace(/[\r\n\t]+/g, ' '));

/**
 * Is the model's answer the remembered one? The same test the agent already scores a purchase with
 * (`res.after.startsWith(expect)`, `agent.ts:697`), on normalised text and case-folded: a completion continues past
 * the fact ("087600 입니다"), so a prefix is the honest comparison, and case is not a difference in an answer.
 */
export function answerMatches(remembered: string, got: string): boolean {
  const a = normalizeAnswer(remembered).toLowerCase();
  const b = normalizeAnswer(got).toLowerCase();
  return !!a && b.startsWith(a);
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------- the event log

export type MemoryLearnSource = 'anchor' | 'dataset' | 'retrieval' | 'bake';

/**
 * A fact entered memory.
 *
 * `alias_of` is the row key this one is ANOTHER WORDING OF, and it is written only where the link is evidence rather
 * than a guess: a retrieval whose query was filtered by the slots a plan bound out of the question. The row it names
 * is the canonical fact; this row is the sentence somebody actually typed. Without it, a question retrieved through
 * a plan is learned under the PLAN's phrasing (`What is the Ethereum mainnet contract address of the USD Coin (USDC)
 * token?`) and never under the asker's (`what is the contract address of USDC?`), so the same question is paid for
 * again on every run and the loop never closes. An alias is recallable, and it is NOT counted as material for a bake
 * — the lesson trains on the retrieved rows, and a second wording of a fact is not a second fact.
 */
export interface LearnPayload { kind: 'learn'; row_key: string; answer: string; source: MemoryLearnSource; engram: string | null; shape: string | null; alias_of?: string }
/** A question was answered — from the cache, from the model, or from memory with nothing to check it against. */
export interface RecallPayload { kind: 'recall'; row_key: string; shape: string | null; hit: boolean; via: 'memory' | 'model' | 'none'; engram: string | null; stack_fp: string | null; ms: number; tokens?: number; answer?: string }
/** An upstream call was paid for. `new_rows`/`refetched`/`churned` are §5.3's retroactive recurrence counter. */
export interface RetrievePayload { kind: 'retrieve'; shape: string; plan_id: string | null; arguments_sha256: string; rows: number; new_rows: number; refetched: number; churned: number; queries: number; bytes: number; ms: number; provenance?: unknown }
/**
 * `runAgent` came back with a receipt. The money itself stays in `purchases.jsonl`, which remains its authority —
 * this event records that the agent now OWNS something, not what it paid. `rebuilt` marks a line reconstructed from
 * a receipt by §2's rule 4 rather than written at the moment of the purchase.
 */
export interface BuyPayload { kind: 'buy'; patch_id: string; sha256: string; amount: string; currency: string; tx_hash: string | null; seller: string | null; rows_learned: number; rebuilt?: boolean }
/**
 * A knowledge is on the model. `observed: true` means the node's table said so — the agent did not do it and must
 * not claim it did; without the flag, this agent applied it.
 */
export interface ApplyPayload { kind: 'apply'; patch_id: string; sha256: string; position: number | null; stack_fp_after: string | null; observed?: boolean }
/** A lesson was submitted, and again at every terminal state. */
export interface BakePayload { kind: 'bake'; shape: string; dataset_id: string | null; dataset_sha256: string | null; job_id: string | null; backend: string | null; status: string; rows: number; total_s: number | null; npz_sha256: string | null; patch_id?: string | null }
/** A reconciliation rule fired. An engram demoted to `unverified` takes its rows with it (see `fold`). */
export interface DemotePayload { kind: 'demote'; target: 'row' | 'engram'; what: string; why: string; from: string; to: string }
/** The two copies disagreed. Both sides are written down; neither is edited to match the other. */
export interface ConflictPayload { kind: 'conflict'; rule: 1 | 2 | 3 | 4; what: string; agent_says: string; node_says: string }

export type MemoryPayload = LearnPayload | RecallPayload | RetrievePayload | BuyPayload | ApplyPayload | BakePayload | DemotePayload | ConflictPayload;
export type MemoryEvent = MemoryPayload & { v: number; at: number };
export type MemoryEventKind = MemoryPayload['kind'];

export function memoryFile(home: string): string { return join(home, 'memory.jsonl'); }
export function memoryIndexFile(home: string): string { return join(home, 'memory-index.json'); }

// ---------------------------------------------------------------------------------------------- the derived index

/** A fact. `state` is about the FACT: `unverified` means the model contradicted it, or its engram changed underneath. */
export interface MemoryRow {
  answer: string;
  engram: string | null;
  source: MemoryLearnSource;
  shape: string | null;
  state: 'known' | 'unverified';
  learned_at: number;
  verified_at: number | null;
  /** Set when this row is another wording of `alias_of` — recallable, but not material for a bake. */
  alias_of?: string;
}

/** A knowledge. `state` is about RESIDENCY — the node's table decides it, never this agent's belief. */
export interface EngramMemory {
  patch_id: string;
  sha256: string;
  state: 'loaded' | 'held' | 'unverified';
  owned: boolean;
  rows: number;
  position: number | null;
  source: 'buy' | 'bake' | 'runtime';
  at: number;
}

/** Everything measured about one shape. The numbers are sums of events; nothing here is an estimate. */
export interface ShapeCounters {
  shape: string;
  plan_id: string | null;
  lookups: number;
  recalls: number;
  recall_hits: number;
  new_rows: number;
  refetched: number;
  churned: number;
  first_at: number;
  last_at: number;
  /** What retrieving this shape has cost, summed over `lookups` measurements. */
  retrieval: { n: number; ms: number; queries: number; bytes: number; rows: number };
  /** What recalling it has cost, summed over the recalls that actually reached a model. */
  recall: { n: number; ms: number; tokens: number };
  /** What compiling it has cost. `n` counts terminal bake states, not submissions. */
  bake: { n: number; total_s: number; jobs: string[] };
}

export interface AnswerCacheEntry { answer: string; at: number; via: 'model' | 'memory' }

export interface MemoryIndex {
  v: number;
  built_at: number;
  /** Bytes of `memory.jsonl` this snapshot was built through — replay starts here, never at zero. */
  through_offset: number;
  /** sha256 of the log's first 256 bytes, so a replaced log is caught instead of half-replayed. */
  head_sha256: string | null;
  events: number;
  last_event_at: number | null;
  counts: Record<string, number>;
  rows: Record<string, MemoryRow>;
  engrams: Record<string, EngramMemory>;
  shapes: Record<string, ShapeCounters>;
  /** `"<stack_fp> <row_key>" → answer` — the model has not changed since this answer was checked. */
  answers: Record<string, AnswerCacheEntry>;
  /** The latest disagreement per `rule:what`, so a permanent foreign layer is recorded once, not once per run. */
  conflicts: Record<string, ConflictPayload & { at: number }>;
}

export function emptyIndex(): MemoryIndex {
  return { v: MEMORY_V, built_at: 0, through_offset: 0, head_sha256: null, events: 0, last_event_at: null, counts: {}, rows: {}, engrams: {}, shapes: {}, answers: {}, conflicts: {} };
}

const shapeOf = (ix: MemoryIndex, shape: string): ShapeCounters => {
  const cur = ix.shapes[shape];
  if (cur) return cur;
  const fresh: ShapeCounters = {
    shape, plan_id: null, lookups: 0, recalls: 0, recall_hits: 0, new_rows: 0, refetched: 0, churned: 0,
    first_at: 0, last_at: 0, retrieval: { n: 0, ms: 0, queries: 0, bytes: 0, rows: 0 }, recall: { n: 0, ms: 0, tokens: 0 }, bake: { n: 0, total_s: 0, jobs: [] },
  };
  ix.shapes[shape] = fresh;
  return fresh;
};

export const answerCacheKey = (stackFp: string, key: string): string => `${stackFp} ${key}`;

/**
 * Fold one event into the index. This is the ONLY place the index changes, so a replay of the log and a live append
 * can never diverge — the same function runs for both.
 */
export function fold(ix: MemoryIndex, e: MemoryEvent): void {
  ix.events += 1;
  ix.counts[e.kind] = (ix.counts[e.kind] ?? 0) + 1;
  ix.last_event_at = e.at;
  switch (e.kind) {
    case 'learn': {
      const prev = ix.rows[e.row_key];
      ix.rows[e.row_key] = {
        answer: e.answer, engram: e.engram, source: e.source, shape: e.shape ?? prev?.shape ?? null,
        state: 'known', learned_at: e.at, verified_at: prev && prev.answer === e.answer ? prev.verified_at : null,
        ...(e.alias_of !== undefined ? { alias_of: e.alias_of } : prev?.alias_of !== undefined ? { alias_of: prev.alias_of } : {}),
      };
      // A fact that MOVED takes its other wordings with it. Without this, a churned answer would be corrected under
      // the plan's phrasing and left stale under the asker's — and recall, which hits the asker's, would keep
      // answering yesterday's fact for ever without ever paying for a lookup that would notice. The walk runs only
      // when an answer actually changed, which is the churn case and is rare.
      if (prev && prev.answer !== e.answer) {
        for (const r of Object.values(ix.rows)) if (r.alias_of === e.row_key) { r.answer = e.answer; r.learned_at = e.at; r.verified_at = null; r.state = 'known'; }
      }
      break;
    }
    case 'recall': {
      if (e.shape) {
        const s = shapeOf(ix, e.shape);
        s.recalls += 1;
        if (e.hit) s.recall_hits += 1;
        if (e.via === 'model') { s.recall.n += 1; s.recall.ms += e.ms; s.recall.tokens += e.tokens ?? 0; }
        s.first_at ||= e.at; s.last_at = e.at;
      }
      const row = ix.rows[e.row_key];
      // The model is the truth: a confirmed row is verified, a contradicted one is demoted where it stands.
      if (row && e.via === 'model') { if (e.hit) { row.state = 'known'; row.verified_at = e.at; } else row.state = 'unverified'; }
      // ONLY a model's answer is cached. The cache means "the model has not changed since this answer was checked",
      // and an answer that came out of memory was never checked against it — caching that would let the agent quote
      // its own belief back to itself as if a model had confirmed it.
      if (e.answer !== undefined && e.stack_fp && e.via === 'model') {
        ix.answers[answerCacheKey(e.stack_fp, e.row_key)] = { answer: e.answer, at: e.at, via: e.via };
      }
      break;
    }
    case 'retrieve': {
      const s = shapeOf(ix, e.shape);
      s.plan_id = e.plan_id ?? s.plan_id;
      s.lookups += 1;
      s.new_rows += e.new_rows; s.refetched += e.refetched; s.churned += e.churned;
      s.retrieval.n += 1; s.retrieval.ms += e.ms; s.retrieval.queries += e.queries; s.retrieval.bytes += e.bytes; s.retrieval.rows += e.rows;
      s.first_at ||= e.at; s.last_at = e.at;
      break;
    }
    case 'buy': {
      const prev = ix.engrams[e.patch_id];
      ix.engrams[e.patch_id] = {
        patch_id: e.patch_id, sha256: e.sha256, owned: true, rows: e.rows_learned || prev?.rows || 0,
        // Buying is not loading. Residency is the node's word, and it is set by `apply` or by `reconcile`.
        state: prev?.state === 'loaded' && prev.sha256 === e.sha256 ? 'loaded' : 'held',
        position: prev?.position ?? null, source: 'buy', at: e.at,
      };
      break;
    }
    case 'apply': {
      const prev = ix.engrams[e.patch_id];
      ix.engrams[e.patch_id] = {
        patch_id: e.patch_id, sha256: e.sha256, owned: prev?.owned ?? true, rows: prev?.rows ?? 0,
        state: 'loaded', position: e.position, source: prev?.source ?? 'buy', at: e.at,
      };
      break;
    }
    case 'bake': {
      const s = shapeOf(ix, e.shape);
      if (e.status === 'DONE' || e.status === 'FAILED' || e.status === 'CANCELLED') {
        s.bake.n += 1;
        s.bake.total_s += e.total_s ?? 0;
        if (e.job_id && !s.bake.jobs.includes(e.job_id)) s.bake.jobs.push(e.job_id);
      } else if (e.job_id && !s.bake.jobs.includes(e.job_id)) s.bake.jobs.push(e.job_id);
      s.last_at = e.at; s.first_at ||= e.at;
      if (e.patch_id) {
        const prev = ix.engrams[e.patch_id];
        ix.engrams[e.patch_id] = {
          patch_id: e.patch_id, sha256: e.npz_sha256 ?? prev?.sha256 ?? '', owned: true, rows: e.rows,
          state: prev?.state === 'loaded' ? 'loaded' : 'held', position: prev?.position ?? null, source: 'bake', at: e.at,
        };
      }
      break;
    }
    case 'demote': {
      if (e.target === 'row') { const r = ix.rows[e.what]; if (r) r.state = e.to === 'known' ? 'known' : 'unverified'; break; }
      const g = ix.engrams[e.what];
      if (g) g.state = e.to === 'loaded' ? 'loaded' : e.to === 'held' ? 'held' : 'unverified';
      // A body that changed underneath takes everything learned from it with it (§2 rule 3): the rows were true of
      // the bytes that are gone, and nothing about the new ones has been checked.
      if (e.to === 'unverified') for (const r of Object.values(ix.rows)) if (r.engram === e.what) r.state = 'unverified';
      break;
    }
    case 'conflict': {
      ix.conflicts[`${e.rule}:${e.what}`] = { kind: 'conflict', rule: e.rule, what: e.what, agent_says: e.agent_says, node_says: e.node_says, at: e.at };
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------- reading the log

function headSample(file: string): string | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = readSync(fd, buf, 0, 256, 0);
      return n > 0 ? sha256(buf.subarray(0, n).toString('utf8')) : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * Read whole lines from `offset` to EOF. Only COMPLETE lines are consumed, so a concurrent `appendFileSync` from a
 * second agent process (a `watch` loop beside an `ask`) is picked up on the next read instead of being half-parsed —
 * the same single-line O_APPEND assumption `purchases.jsonl` already makes.
 */
function readEventsFrom(file: string, offset: number): { events: MemoryEvent[]; end: number; size: number } {
  if (!existsSync(file)) return { events: [], end: 0, size: 0 };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return { events: [], end: Math.min(offset, size), size };
    const len = size - offset;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) { const n = readSync(fd, buf, read, len - read, offset + read); if (n <= 0) break; read += n; }
    const lastNl = buf.subarray(0, read).lastIndexOf(0x0a);
    if (lastNl < 0) return { events: [], end: offset, size };
    const events: MemoryEvent[] = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as MemoryEvent); } catch { /* a half-written line is not an event */ }
    }
    return { events, end: offset + lastNl + 1, size };
  } finally { closeSync(fd); }
}

/** Rebuild the index from the snapshot plus the tail of the log. A missing or stale snapshot costs a replay. */
export function loadIndex(home: string): MemoryIndex {
  const log = memoryFile(home);
  const snapPath = memoryIndexFile(home);
  let ix = emptyIndex();
  const head = headSample(log);
  try {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as MemoryIndex;
    const size = existsSync(log) ? statSync(log).size : 0;
    const usable = snap.v === MEMORY_V && snap.through_offset <= size && snap.head_sha256 === head;
    if (usable) ix = { ...emptyIndex(), ...snap, counts: { ...snap.counts }, rows: { ...snap.rows }, engrams: { ...snap.engrams }, shapes: { ...snap.shapes }, answers: { ...snap.answers }, conflicts: { ...snap.conflicts } };
  } catch { /* no snapshot, or one we cannot use — replay from zero, which costs time and loses nothing */ }
  const { events, end } = readEventsFrom(log, ix.through_offset);
  for (const e of events) fold(ix, e);
  ix.through_offset = end;
  ix.head_sha256 = head;
  return ix;
}

// ---------------------------------------------------------------------------------------------- the runtime side

export interface RuntimeLayer {
  patch_id: string; sha256: string; position: number;
  name?: string | null; rows?: number | null; applied_at?: number; reason?: string;
  body_present?: boolean; journal?: boolean; present?: boolean | null; checked_at?: number | null;
}

/** What `GET /api/runtime` said, as the memory layer needs it. `ok:false` means "unknown", never "empty". */
export interface RuntimeView {
  ok: boolean;
  url: string;
  api: string | null;
  model: string | null;
  available?: boolean;
  stack: RuntimeLayer[];
  checked: { patch_id: string; sha256: string; at: number; present: boolean; source: string } | null;
  stack_fp: string | null;
  at: number;
  error?: string;
}

/**
 * The invalidation key for every cached answer (§4.3): the model plus the ordered stack, exactly as the node reports
 * it. It changes when anything at all is applied, removed, reordered or re-bodied — by this agent or by another
 * tenant of the same shared model — which is the only honest way to know a remembered answer is still the model's.
 */
export function stackFingerprint(model: string | null, stack: RuntimeLayer[]): string {
  const lines = [...stack].sort((a, b) => a.position - b.position || a.patch_id.localeCompare(b.patch_id))
    .map((l) => `${l.position}:${l.patch_id}:${l.sha256}`);
  return sha256([model ?? '(no model)', ...lines].join('\n'));
}

const runtimeCache = new Map<string, RuntimeView>();
/** Tests and long-lived processes that must not reuse a 5-second-old read. */
export function clearRuntimeCache(): void { runtimeCache.clear(); }

/**
 * Read the PUBLIC runtime endpoint (no operator credential — the agent is not the node's operator) and fingerprint
 * it. A node that does not answer gives `ok:false`, and every caller must treat that as "unknown", not as "nothing
 * is loaded": demoting a knowledge because a node was briefly unreachable would be a guess.
 */
export async function fetchRuntime(market: string, opts: { timeoutMs?: number; cacheMs?: number; now?: number } = {}): Promise<RuntimeView> {
  const url = `${market.replace(/\/+$/, '')}/api/runtime`;
  const now = opts.now ?? Date.now();
  const cacheMs = opts.cacheMs ?? RUNTIME_CACHE_MS;
  const hit = runtimeCache.get(url);
  if (hit && now - hit.at < cacheMs) return hit;
  let view: RuntimeView;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
    const body = JSON.parse(text) as { api?: string | null; model?: string | null; available?: boolean; stack?: RuntimeLayer[]; checked?: RuntimeView['checked'] };
    const stack = (body.stack ?? []).map((l, i) => ({ ...l, position: l.position ?? i }));
    view = {
      ok: true, url, api: body.api ?? null, model: body.model ?? null, available: body.available,
      stack, checked: body.checked ?? null, stack_fp: stackFingerprint(body.model ?? null, stack), at: now,
    };
  } catch (e) {
    view = { ok: false, url, api: null, model: null, stack: [], checked: null, stack_fp: null, at: now, error: (e as Error).message };
  }
  runtimeCache.set(url, view);
  return view;
}

// ---------------------------------------------------------------------------------------------- recall (§4)

export type RecallDecision = 'cache' | 'confirm' | 'offline' | 'miss';

export interface RecallView {
  question: string;
  row_key: string;
  hit: boolean;
  answer: string | null;
  engram: string | null;
  state: MemoryRow['state'] | null;
  /** Its knowledge is on the model right now — or it needs none, because the fact is the agent's own. */
  resident: boolean;
  cached: boolean;
  cache_age_ms: number | null;
  stack_fp: string | null;
  shape: string | null;
  learned_at: number | null;
  verified_at: number | null;
  decision: RecallDecision;
  reason: string;
  /** The sentence to print, in the caller's language. */
  line: string;
}

export interface RecallContext { stackFp: string | null; hasModel: boolean; now?: number; ttlMs?: number }

/**
 * "Can I answer this from the memory I already carry?" — decided at ZERO completions, by the index (§4).
 *
 * The model is never asked whether it knows something. It is asked at most once per state of the model, and that one
 * call is both the check and the answer. This function only decides; the caller (G5's `ask`) executes.
 */
export function decideRecall(ix: MemoryIndex, question: string, ctx: RecallContext): RecallView {
  const now = ctx.now ?? Date.now();
  const ttl = ctx.ttlMs ?? ANSWER_TTL_MS;
  const key = rowKey(question);
  const row = ix.rows[key];
  const base = {
    question, row_key: key, hit: !!row, answer: row?.answer ?? null, engram: row?.engram ?? null,
    state: row?.state ?? null, shape: row?.shape ?? null, learned_at: row?.learned_at ?? null,
    verified_at: row?.verified_at ?? null, stack_fp: ctx.stackFp,
  };
  if (!row) {
    return { ...base, resident: false, cached: false, cache_age_ms: null, decision: 'miss', reason: 'unknown_question', line: t('mem.recall.miss', { rows: Object.keys(ix.rows).length }) };
  }
  const engram = row.engram ? ix.engrams[row.engram] : undefined;
  // A fact with no engram is the agent's own (retrieved, or learned from a dataset): nothing has to be on the model
  // for the agent to hold it. A fact attributed to a knowledge is only "on the model" while that knowledge is.
  const resident = !row.engram || engram?.state === 'loaded';
  const cacheEntry = ctx.stackFp ? ix.answers[answerCacheKey(ctx.stackFp, key)] : undefined;
  const cached = !!cacheEntry && now - cacheEntry.at < ttl;
  const age = cacheEntry ? now - cacheEntry.at : null;
  if (row.state === 'unverified') {
    const why = engram && engram.state === 'unverified' ? t('mem.why.bodyChanged', { patch: row.engram ?? '' }) : t('mem.why.modelDisagreed');
    return { ...base, resident, cached, cache_age_ms: age, decision: 'miss', reason: 'unverified', line: t('mem.recall.unverified', { why }) };
  }
  if (cached && cacheEntry) {
    return {
      ...base, answer: cacheEntry.answer, resident, cached: true, cache_age_ms: age, decision: 'cache', reason: 'cache_fresh',
      line: t('mem.recall.cache', { engram: row.engram ?? t('mem.own'), date: new Date(row.learned_at).toISOString().slice(0, 10), age: humanMs(age ?? 0) }),
    };
  }
  if (ctx.hasModel && resident) {
    return { ...base, resident, cached: false, cache_age_ms: age, decision: 'confirm', reason: 'resident', line: t('mem.recall.confirm', { date: new Date(row.learned_at).toISOString().slice(0, 10) }) };
  }
  // No model to ask, or the knowledge this fact came from is not on the one there is. Either way the answer is
  // remembered rather than the model's, and the label travels with it (arm C's offline claim, §4).
  const why = !ctx.hasModel ? t('mem.why.noModel') : t('mem.why.notResident', { patch: row.engram ?? '' });
  return { ...base, resident, cached: false, cache_age_ms: age, decision: 'offline', reason: !ctx.hasModel ? 'no_model' : 'not_resident', line: t('mem.recall.offline', { why }) };
}

/**
 * The sentence for a completion that contradicted memory. The demotion itself happens when the caller records the
 * `recall` event with `hit: false` — this is only how it is said, in the reader's language.
 */
export function recallMismatchLine(row_key: string, expected: string, got: string): string {
  return t('mem.recall.mismatch', { row: row_key, expected: JSON.stringify(expected), got: JSON.stringify(normalizeAnswer(got).slice(0, 80)) });
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 3600_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / (24 * 3600_000))}d`;
}

// ---------------------------------------------------------------------------------------------- reconciliation

/** What a bought knowledge publishes about itself: up to 32 `{prompt, expect}` samples on the ledger. */
export interface AnchorSeed { patch_id: string; sha256: string; samples: { prompt: string; expect: string }[] }
/** The receipt shape `purchases.jsonl` already holds (`agent.ts`), narrowed to what reconciliation needs. */
export interface PurchaseSeed { patch_id: string; sha256: string; at?: number; amount?: string; currency?: string; tx_hash?: string | null; seller?: string | null }

export interface ReconcileReport {
  runtime_ok: boolean;
  stack_fp: string | null;
  memory_empty: boolean;
  /** Every rule that fired, with both sides and the sentence to print. */
  fired: { rule: 1 | 2 | 3 | 4; what: string; agent_says: string; node_says: string; action: string; line: string }[];
  /** Every state change this reconciliation made, as one line each. */
  demoted: { target: 'row' | 'engram'; what: string; from: string; to: string; why: string; line: string }[];
  /** Layers on the model that this agent does not own — counted in the fingerprint, never touched. */
  foreign: string[];
  /** Knowledge the node lists that this agent owns: residency confirmed from the authority on residency. */
  resident: string[];
  rebuilt: { engrams: number; rows: number } | null;
  lines: string[];
}

// ---------------------------------------------------------------------------------------------- the memory itself

export interface AgentMemoryOptions { now?: () => number }

/**
 * The append-only memory of one agent home.
 *
 * Every mutation is an event on disk first and an index entry second, so two agent processes sharing a home converge:
 * each one re-reads the tail it has not seen before it decides anything.
 */
export class AgentMemory {
  readonly home: string;
  readonly file: string;
  readonly indexFile: string;
  private ix: MemoryIndex;
  private dirty = 0;
  private readonly now: () => number;

  private constructor(home: string, ix: MemoryIndex, opts: AgentMemoryOptions = {}) {
    this.home = home;
    this.file = memoryFile(home);
    this.indexFile = memoryIndexFile(home);
    this.ix = ix;
    this.now = opts.now ?? Date.now;
  }

  static open(home: string, opts: AgentMemoryOptions = {}): AgentMemory {
    return new AgentMemory(home, loadIndex(home), opts);
  }

  /** Pick up anything another process appended since the last read. Cheap: it reads from the stored offset. */
  refresh(): this {
    const { events, end } = readEventsFrom(this.file, this.ix.through_offset);
    for (const e of events) fold(this.ix, e);
    this.ix.through_offset = end;
    if (events.length) this.ix.head_sha256 = headSample(this.file);
    return this;
  }

  get index(): MemoryIndex { return this.ix; }
  get exists(): boolean { return existsSync(this.file); }
  /** True when this home has never recorded anything — §2's rule 4 tests exactly this. */
  get isEmpty(): boolean { return this.ix.events === 0; }

  /** Append one event. The line is on disk before the index moves — the log is the record, the index is a cache. */
  append(payload: MemoryPayload, at = this.now()): MemoryEvent {
    const e = { v: MEMORY_V, at, ...payload } as MemoryEvent;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const first = !existsSync(this.file);
    appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 });
    if (first) this.ix.head_sha256 = headSample(this.file);
    this.refresh();
    this.dirty += 1;
    return e;
  }

  appendAll(payloads: MemoryPayload[], at = this.now()): MemoryEvent[] {
    return payloads.map((p) => this.append(p, at));
  }

  /**
   * Write the derived snapshot: tmp + rename, the `PurchaseJournal.flush` pattern, so a crash mid-write leaves the
   * previous snapshot rather than a truncated one. Deleting the file costs a replay of the log, never a fact.
   */
  save(): void {
    if (!existsSync(this.file)) return;
    this.refresh();
    const answers = Object.entries(this.ix.answers).sort((a, b) => b[1].at - a[1].at).slice(0, ANSWER_CACHE_MAX);
    const snap: MemoryIndex = { ...this.ix, built_at: this.now(), answers: Object.fromEntries(answers) };
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap) + '\n', { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.indexFile);
      this.ix.answers = snap.answers;
      this.dirty = 0;
    } catch { /* a snapshot we cannot write is a replay next time, not a lost fact */ }
  }

  /** `save()` only if something was appended since the last one — for a CLI that ends without knowing. */
  flush(): void { if (this.dirty) this.save(); }

  // -------------------------------------------------------------------------------- writing things down

  /** A fact enters memory. Returns the keys it landed on, so a caller can count what was actually new. */
  learn(rows: { prompt: string; answer: string; source: MemoryLearnSource; engram?: string | null; shape?: string | null; aliasOf?: string }[], at = this.now()): string[] {
    const keys: string[] = [];
    for (const r of rows) {
      const key = rowKey(r.prompt);
      const answer = normalizeAnswer(r.answer);
      if (!key || !answer) continue;   // an empty question or an empty answer is not a fact
      if (r.aliasOf === key) continue;  // the wording somebody used IS the row's own — there is no second wording
      this.append({ kind: 'learn', row_key: key, answer, source: r.source, engram: r.engram ?? null, shape: r.shape ?? null, ...(r.aliasOf ? { alias_of: r.aliasOf } : {}) }, at);
      keys.push(key);
    }
    return keys;
  }

  /**
   * Remember a fact under the wording it was ASKED in, pointing at the row that answered it.
   *
   * Only the retrieval path may call this, and only when the plan's own filter is what produced the row: the slots
   * were bound out of the question and the upstream query carried them, so "this row is the answer to this question"
   * is something that was measured, not inferred from two sentences looking alike.
   */
  learnAsked(p: { question: string; answer: string; canonical: string; shape: string | null }, at = this.now()): string | null {
    const [key] = this.learn([{ prompt: p.question, answer: p.answer, source: 'retrieval', engram: null, shape: p.shape, aliasOf: p.canonical }], at);
    return key ?? null;
  }

  /** Seed memory from a knowledge's published benchmark samples (up to 32 on the ledger). */
  learnFromAnchor(seed: AnchorSeed, at = this.now()): string[] {
    return this.learn(seed.samples.map((s) => ({ prompt: s.prompt, answer: s.expect, source: 'anchor' as const, engram: seed.patch_id })), at);
  }

  recordRecall(p: Omit<RecallPayload, 'kind'>, at = this.now()): MemoryEvent { return this.append({ kind: 'recall', ...p }, at); }
  recordRetrieve(p: Omit<RetrievePayload, 'kind'>, at = this.now()): MemoryEvent { return this.append({ kind: 'retrieve', ...p }, at); }
  recordBuy(p: Omit<BuyPayload, 'kind'>, at = this.now()): MemoryEvent { return this.append({ kind: 'buy', ...p }, at); }
  recordApply(p: Omit<ApplyPayload, 'kind'>, at = this.now()): MemoryEvent { return this.append({ kind: 'apply', ...p }, at); }
  recordBake(p: Omit<BakePayload, 'kind'>, at = this.now()): MemoryEvent { return this.append({ kind: 'bake', ...p }, at); }

  /**
   * §5.3's retroactive counter, and the one piece of recurrence evidence that is exact rather than fuzzy: a row key
   * already in memory proves this agent paid twice for the same fact, however the two questions were worded.
   * `churned` is the counter-signal — a fact whose answer MOVED belongs in The Graph, not compiled into memory.
   */
  classifyRows(rows: { prompt: string; answer: string }[]): { keys: string[]; new_rows: number; refetched: number; churned: number } {
    const keys: string[] = [];
    let fresh = 0, refetched = 0, churned = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      const key = rowKey(r.prompt);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      const known = this.ix.rows[key];
      if (!known) { fresh += 1; continue; }
      refetched += 1;
      if (normalizeAnswer(known.answer) !== normalizeAnswer(r.answer)) churned += 1;
    }
    return { keys, new_rows: fresh, refetched, churned };
  }

  /** Is this answer already cached for the state the model is in? (No network, no model — one map lookup.) */
  cachedAnswer(question: string, stackFp: string | null, now = this.now(), ttlMs = ANSWER_TTL_MS): AnswerCacheEntry | null {
    if (!stackFp) return null;
    const e = this.ix.answers[answerCacheKey(stackFp, rowKey(question))];
    return e && now - e.at < ttlMs ? e : null;
  }

  recall(question: string, ctx: RecallContext): RecallView {
    return decideRecall(this.ix, question, { now: this.now(), ...ctx });
  }

  // -------------------------------------------------------------------------------- reconciliation (§2)

  /**
   * The node wins about the model; the agent wins about itself; a disagreement is recorded, not silently resolved.
   *
   * Runs at the start of every `ask` and costs one public GET. Four rules, each writing a `conflict` event carrying
   * BOTH sides — deduplicated on `rule:what`, so a foreign layer that is simply always there is recorded once and
   * not once per run.
   */
  reconcile(runtime: RuntimeView, seeds: { purchases?: PurchaseSeed[]; anchors?: AnchorSeed[] } = {}, at = this.now()): ReconcileReport {
    this.refresh();
    const purchases = seeds.purchases ?? [];
    const report: ReconcileReport = {
      runtime_ok: runtime.ok, stack_fp: runtime.stack_fp, memory_empty: this.isEmpty,
      fired: [], demoted: [], foreign: [], resident: [], rebuilt: null, lines: [],
    };
    const demote = (target: 'row' | 'engram', what: string, from: string, to: string, why: string) => {
      this.append({ kind: 'demote', target, what, why, from, to }, at);
      report.demoted.push({ target, what, from, to, why, line: t('mem.demoted', { what, from, to }) });
    };
    const fire = (rule: 1 | 2 | 3 | 4, what: string, agent_says: string, node_says: string, action: string, line: string) => {
      const prev = this.ix.conflicts[`${rule}:${what}`];
      if (!prev || prev.agent_says !== agent_says || prev.node_says !== node_says) {
        this.append({ kind: 'conflict', rule, what, agent_says, node_says }, at);
      }
      report.fired.push({ rule, what, agent_says, node_says, action, line });
      report.lines.push(line);
    };

    // Rule 4 — the home is gone. Rebuild what CAN be rebuilt and say plainly what cannot.
    if (this.isEmpty && (purchases.length || runtime.stack.length)) {
      let rows = 0;
      const owned = new Map(purchases.map((p) => [p.patch_id, p]));
      for (const a of seeds.anchors ?? []) if (owned.has(a.patch_id)) rows += this.learnFromAnchor(a, at).length;
      for (const p of purchases) {
        const onModel = runtime.stack.find((l) => l.patch_id === p.patch_id);
        // Copied from the receipt, never invented: the amount is what `purchases.jsonl` says it was, and the line
        // is marked `rebuilt` so nothing later mistakes a reconstruction for a purchase this run made.
        this.append({ kind: 'buy', patch_id: p.patch_id, sha256: p.sha256, amount: p.amount ?? '', currency: p.currency ?? '', tx_hash: p.tx_hash ?? null, seller: p.seller ?? null, rows_learned: 0, rebuilt: true }, p.at ?? at);
        if (onModel) this.append({ kind: 'apply', patch_id: p.patch_id, sha256: onModel.sha256, position: onModel.position, stack_fp_after: runtime.stack_fp, observed: true }, at);
      }
      report.rebuilt = { engrams: purchases.length, rows };
      const line = t('mem.conflict.homeEmpty', { home: this.home, engrams: purchases.length, rows });
      fire(4, this.home, 'no memory at all', `${runtime.stack.length} layer(s) on the model, ${purchases.length} receipt(s) on disk`, 'rebuilt residency and ownership; lookup history NOT rebuilt', line);
    }

    // Without an answer from the node, residency is UNKNOWN. Nothing is demoted on a guess.
    if (!runtime.ok) {
      report.lines.push(t('mem.conflict.noRuntime', { market: runtime.url, error: runtime.error ?? 'no answer' }));
      return report;
    }

    const onModel = new Map(runtime.stack.map((l) => [l.patch_id, l]));
    const ownedIds = new Set([...Object.keys(this.ix.engrams), ...purchases.map((p) => p.patch_id)]);

    for (const [id, g] of Object.entries(this.ix.engrams)) {
      const layer = onModel.get(id);
      // Rule 1 — memory says loaded, the node does not list it.
      if (!layer && g.state === 'loaded') {
        demote('engram', id, 'loaded', 'held', 'the node does not list it in the applied stack');
        fire(1, id, 'loaded', 'not in the applied stack', 'demoted to held', t('mem.conflict.notResident', { patch: id }));
        continue;
      }
      if (!layer) continue;
      // Rule 3 — same id, different body.
      if (g.sha256 && layer.sha256 && g.sha256 !== layer.sha256) {
        const rows = Object.values(this.ix.rows).filter((r) => r.engram === id).length;
        demote('engram', id, g.state, 'unverified', `the body on the model is ${layer.sha256.slice(0, 12)}…, memory recorded ${g.sha256.slice(0, 12)}…`);
        fire(3, id, `sha256 ${g.sha256}`, `sha256 ${layer.sha256}`, `demoted to unverified with ${rows} fact(s)`,
          t('mem.conflict.bodyChanged', { patch: id, node_sha: layer.sha256.slice(0, 12), agent_sha: g.sha256.slice(0, 12), rows }));
        continue;
      }
      /*
       * Rule 1 again, from the node's own MEASUREMENT rather than from its table. `present: false` is the watchdog
       * reporting that it read the live rows for this layer and this knowledge was not among them
       * (`market.runtimeCheck()`) — a serving-model restart drops every live patch while the table still lists it.
       * A measurement beats the record that predicted it, so this demotes exactly as a missing row would.
       */
      if (layer.present === false && g.state === 'loaded') {
        demote('engram', id, 'loaded', 'held', `the node measured the live table at ${new Date(layer.checked_at ?? at).toISOString()} and this knowledge was not in it`);
        fire(1, id, 'loaded', 'listed, but measured as not on the live table', 'demoted to held', t('mem.conflict.notResident', { patch: id }));
        continue;
      }
      // Agreement: the authority on residency says it is there.
      // `observed`: the node's table is the authority on residency, and this agent did not put it there.
      if (g.state !== 'loaded' || g.position !== layer.position) this.append({ kind: 'apply', patch_id: id, sha256: layer.sha256, position: layer.position, stack_fp_after: runtime.stack_fp, observed: true }, at);
      report.resident.push(id);
    }

    // Rule 2 — a layer this agent does not own. It counts in the fingerprint (so cached answers invalidate), it never
    // becomes this agent's memory, and it is NEVER removed: removing it writes the model's own rows back over
    // somebody else's knowledge.
    for (const l of runtime.stack) {
      if (ownedIds.has(l.patch_id)) continue;
      report.foreign.push(l.patch_id);
      fire(2, l.patch_id, 'not owned by this agent', `position ${l.position}, sha256 ${l.sha256}`, 'left alone; counted in the stack fingerprint',
        t('mem.conflict.foreign', { patch: l.patch_id }));
    }
    return report;
  }

  // -------------------------------------------------------------------------------- `agent memory` (§9)

  view(opts: { shape?: string; rows?: number; now?: number } = {}): MemoryView { return memoryView(this, opts); }
}

// ---------------------------------------------------------------------------------------------- view models

export interface MemoryShapeView extends ShapeCounters {
  /** Distinct facts in memory attributed to this shape — the material gate's input (`rowsPerJob.floorGradient`). */
  distinct_rows: number;
  churn_rate: number | null;
  /** How many measurements each side of N* has. Below the node's own ETA_MIN_SAMPLES, N* is not computable. */
  measurements: { retrieval: number; recall: number; bake: number };
  /** Per-lookup and per-recall unit costs, or null where nothing has been measured yet. Never estimated. */
  per_lookup: { ms: number; queries: number; bytes: number } | null;
  per_recall: { ms: number; tokens: number } | null;
  line: string;
}

export interface MemoryView {
  home: string;
  memory_file: string;
  index_file: string;
  exists: boolean;
  events: number;
  counts: Record<string, number>;
  through_offset: number;
  last_event_at: number | null;
  facts: number;
  facts_by_state: { known: number; unverified: number };
  engrams: EngramMemory[];
  engrams_by_state: { loaded: number; held: number; unverified: number };
  shapes: MemoryShapeView[];
  conflicts: (ConflictPayload & { at: number })[];
  rows: ({ row_key: string } & MemoryRow)[];
  summary: string;
}

/** Everything `agent memory` prints, computed from files on disk and nothing else. */
export function memoryView(mem: AgentMemory, opts: { shape?: string; rows?: number; now?: number } = {}): MemoryView {
  const ix = mem.refresh().index;
  const rowsList = Object.entries(ix.rows).map(([row_key, r]) => ({ row_key, ...r })).sort((a, b) => b.learned_at - a.learned_at);
  const facts_by_state = { known: 0, unverified: 0 };
  for (const r of rowsList) facts_by_state[r.state] += 1;
  const engrams = Object.values(ix.engrams).sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || b.at - a.at);
  const engrams_by_state = { loaded: 0, held: 0, unverified: 0 };
  for (const g of engrams) engrams_by_state[g.state] += 1;
  // Material for a bake, per shape. An ALIAS is excluded: the lesson trains on the rows `retrieve.ts` wrote down, so
  // counting a second wording of one fact here would let the material gate pass on 8 with 4 rows in the dataset.
  const distinct = new Map<string, number>();
  for (const r of rowsList) if (r.shape && r.alias_of === undefined) distinct.set(r.shape, (distinct.get(r.shape) ?? 0) + 1);
  const shapes = Object.values(ix.shapes)
    .filter((s) => !opts.shape || s.shape === opts.shape || s.shape.startsWith(opts.shape) || s.plan_id === opts.shape)
    .map((s): MemoryShapeView => ({
      ...s,
      distinct_rows: distinct.get(s.shape) ?? 0,
      churn_rate: s.refetched > 0 ? Math.round((s.churned / s.refetched) * 1000) / 1000 : null,
      measurements: { retrieval: s.retrieval.n, recall: s.recall.n, bake: s.bake.n },
      per_lookup: s.retrieval.n ? { ms: Math.round(s.retrieval.ms / s.retrieval.n), queries: Math.round((s.retrieval.queries / s.retrieval.n) * 100) / 100, bytes: Math.round(s.retrieval.bytes / s.retrieval.n) } : null,
      per_recall: s.recall.n ? { ms: Math.round(s.recall.ms / s.recall.n), tokens: Math.round((s.recall.tokens / s.recall.n) * 100) / 100 } : null,
      line: t('mem.view.shape', { shape: s.shape.slice(0, 12), lookups: s.lookups, rows: distinct.get(s.shape) ?? 0, new_rows: s.new_rows, refetched: s.refetched, churned: s.churned, retrieval_n: s.retrieval.n, recall_n: s.recall.n, bake_n: s.bake.n }),
    }))
    .sort((a, b) => b.lookups - a.lookups || b.last_at - a.last_at);
  const summary = mem.exists
    ? t('mem.view.summary', {
      home: mem.home, rows: rowsList.length, engrams: engrams.length,
      loaded: engrams_by_state.loaded, held: engrams_by_state.held, unverified: engrams_by_state.unverified,
      shapes: Object.keys(ix.shapes).length, events: ix.events,
    })
    : t('mem.view.empty', { file: mem.file });
  return {
    home: mem.home, memory_file: mem.file, index_file: mem.indexFile, exists: mem.exists,
    events: ix.events, counts: ix.counts, through_offset: ix.through_offset, last_event_at: ix.last_event_at,
    facts: rowsList.length, facts_by_state, engrams, engrams_by_state, shapes,
    conflicts: Object.values(ix.conflicts).sort((a, b) => b.at - a.at),
    rows: rowsList.slice(0, opts.rows ?? 20),
    summary,
  };
}

/** One line about the model the answers were cached against — printed by `agent memory` beside the summary. */
export function runtimeLine(r: RuntimeView): string {
  if (!r.ok || !r.model) return t('mem.view.noStack');
  return t('mem.view.stack', { api: r.api ?? r.url, model: r.model, layers: r.stack.length, fp: (r.stack_fp ?? '').slice(0, 12) });
}
