/**
 * The cost path of the loop (design §5): ask somebody else's MCP server, turn the answer into canonical rows with
 * the provenance sealed onto them, and write down what the agent just paid for.
 *
 * Three things happen here and nothing else:
 *
 *  1. **One query, reserved before it leaves.** The `queries` budget is a check-and-hold: reserved before the call,
 *     released when the call never left this machine, settled when it did — including when the far side answered
 *     with a failure, because a failed query still cost a query. The client is built with `maxRetries: 0` on
 *     purpose: an invisible retry is an invisible query, and this agent has to be able to say what it spent.
 *  2. **Rows, with the block they were true at.** `McpDataSource.fetchRows` seals a provenance record from an
 *     `upstream` the caller must know BEFORE the call, which cannot carry the block number — and reading the block
 *     with a second call would pin the rows to a block that is not the one they came from. So this composes
 *     `datasource.call` with the same exported pieces `fetchRows` itself uses (`mapRows` → `withProvenanceNotes` →
 *     `sealProvenance`), in the same order, with the same error codes, and lifts `upstream_from` out of the very
 *     response the rows were mapped from. It is not a second client and not a second mapper.
 *  3. **The retroactive counter.** Every row's `promptKey` is the node's own de-dupe key. A key already in this
 *     agent's memory proves it paid twice for one fact — however the two questions were worded, and even if they
 *     matched different plans. That is `refetched`, and it is exact rather than fuzzy. `churned` is the same key
 *     coming back with a DIFFERENT answer, which is the counter-signal: a shape whose answers move belongs in The
 *     Graph, not compiled into a memory.
 *
 * Memory and budget arrive as ports, not as imports: this module owns retrieval, `memory.ts` owns what the agent
 * knows and `budget.ts` owns what it may spend, and the loop (`ask.ts`) wires the three together.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpDataSource, McpDataSourceError, getPath, mapRows, promptKey, sealProvenance, withProvenanceNotes,
  type McpCallResult, type RowProvenance, type TeachRow,
} from '@ngram/mcp/client';
import { translator, type Locale } from './i18n.js';
import { RETRIEVE_STRINGS } from './strings/retrieve.js';
import {
  bindPlan, matchQuestion, shapeDescriptor, shapeKey, shortShape,
  type AgentPlan, type BoundPlan, type PlanCandidate, type ShapeDescriptor, type SlotRefusal,
} from './plans.js';

// ------------------------------------------------------------------------------------------------ the ports

/**
 * What retrieval needs from the agent's memory (G1). Two methods, because retrieval only ever asks one question of
 * memory ("have I held this fact before?") and only ever tells it two things (a fact arrived, a query was spent).
 */
export interface RetrieveMemory {
  /** The answer this agent already holds for a normalized prompt key, or null when it has never held that fact. */
  row(rowKey: string): { answer: string } | null;
  append(event: RetrieveEvent | LearnEvent): void;
}

export interface RetrieveEvent {
  kind: 'retrieve';
  shape: string;
  plan_id: string;
  arguments_sha256: string;
  rows: number;
  new_rows: number;
  refetched: number;
  churned: number;
  queries: number;
  bytes: number;
  ms: number;
  provenance: CappedProvenance;
}

export interface LearnEvent {
  kind: 'learn';
  row_key: string;
  answer: string;
  source: 'retrieval';
  engram: null;
  shape: string;
}

/** What retrieval needs from the budget (G3): a check-and-hold it cannot argue with. */
export interface BudgetHold {
  /** The reservation became a real spend. `actual` defaults to what was reserved. */
  settle(actual?: number): void;
  /** Nothing was spent; give the reservation back. */
  release(): void;
}
export interface QueryBudget {
  reserve(kind: 'queries', amount: number, forWhat: string): BudgetHold;
}

/** The MCP client, as this module uses it. `McpDataSource` satisfies it; a test can too. */
export interface RetrievalSource {
  connect(): Promise<unknown>;
  call(tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ provenance

/**
 * The provenance that goes in the memory LINE. The full record is written to disk uncapped; this is the summary
 * that keeps `memory.jsonl` appendable a line at a time (a single `write()` of a few hundred bytes), with
 * `record` naming the file that holds everything, including the query text and every row hash.
 */
export interface CappedProvenance {
  source: 'mcp';
  server: RowProvenance['server'];
  tool: string;
  arguments_sha256: string;
  fetched_at: number;
  upstream?: Record<string, string | number | boolean | null>;
  rows_sha256: string;
  rows: number;
  row_hashes?: string[];
  row_hashes_omitted?: number;
  /** Where the complete sealed record lives. */
  record: string;
}

/** Keep the shape of the record, drop the parts that have no bound: the query text and the per-row hashes. */
export function capProvenance(p: RowProvenance, record: string, maxHashes = 8): CappedProvenance {
  const keep = p.row_hashes.slice(0, maxHashes);
  return {
    source: 'mcp',
    server: p.server,
    tool: p.tool,
    arguments_sha256: p.arguments_sha256,
    fetched_at: p.fetched_at,
    ...(p.upstream ? { upstream: p.upstream } : {}),
    rows_sha256: p.rows_sha256,
    rows: p.rows,
    ...(keep.length ? { row_hashes: keep } : {}),
    ...(p.row_hashes.length > keep.length ? { row_hashes_omitted: p.row_hashes.length - keep.length } : {}),
    record,
  };
}

// ------------------------------------------------------------------------------------------------ the store

/** Where the rows a shape has produced are kept, so a later bake trains on what was actually retrieved. */
export const retrievedDir = (home: string): string => join(home, 'retrieved');

export function shapeFiles(home: string, shape: string): { rows: string; provenance: string; shape: string } {
  const base = join(retrievedDir(home), shortShape(shape));
  return { rows: `${base}.jsonl`, provenance: `${base}.provenance.jsonl`, shape: `${base}.shape.json` };
}

interface StoredShape { shape: string; descriptor: ShapeDescriptor; plan_id: string; first_seen: number }

/**
 * Write the shape's identity once, and refuse to share a file between two shapes: the file name is 12 hex of the
 * key, and two different shapes landing on one row set would merge two products into one dataset in silence.
 */
function writeShapeDescriptor(home: string, shape: string, descriptor: ShapeDescriptor, planId: string, at: number): void {
  const file = shapeFiles(home, shape).shape;
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, 'utf8')) as StoredShape;
    if (prev.shape !== shape) {
      throw new Error(`${file} already holds shape ${prev.shape}, and this call is shape ${shape} — two shapes cannot share one row set`);
    }
    return;
  }
  const body: StoredShape = { shape, descriptor, plan_id: planId, first_seen: at };
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
}

export function readShapeDescriptor(home: string, shape: string): StoredShape | null {
  const file = shapeFiles(home, shape).shape;
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as StoredShape;
}

/** Rows and the sealed record, appended. One `write()` each, so two agent processes interleave lines, never bytes. */
function appendRetrieved(home: string, shape: string, rows: TeachRow[], provenance: RowProvenance, meta: { plan_id: string; slots: Record<string, string>; at: number }): { rows_file: string; provenance_file: string } {
  const files = shapeFiles(home, shape);
  if (rows.length) {
    appendFileSync(files.rows, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  }
  appendFileSync(files.provenance, JSON.stringify({ ...meta, shape, provenance }) + '\n', { mode: 0o600 });
  return { rows_file: files.rows, provenance_file: files.provenance };
}

/**
 * Every retrieval of one shape, folded into ONE record for the lesson that will be baked from them.
 *
 * `<shape>.provenance.jsonl` is JSONL — one sealed record per upstream call — and a shape only reaches the material
 * gate after several of them. `bake.ts` read it with a bare `JSON.parse` of the whole file, which throws on the
 * second line, so for every shape that could actually be baked the provenance was swallowed by an empty catch and
 * the lesson was submitted with none (measured 2026-09-07: an 8-call shape, 8 lines, `Unexpected non-whitespace
 * character after JSON at position 1100`).
 *
 * The fold states only what is true of ALL the calls: the server and the tool are in the shape key, so there cannot
 * be two of them; an upstream field two calls disagreed about is DROPPED rather than averaged, because a lesson made
 * at two different blocks was not made at either of them.
 */
export interface ShapeProvenance {
  source: 'mcp';
  shape: string;
  plan_id: string | null;
  server: RowProvenance['server'] | null;
  tool: string | null;
  /** Only the pins every call agreed on. A field they disagreed about is in `upstream_varied` instead. */
  upstream: Record<string, string | number | boolean | null>;
  upstream_varied: string[];
  calls: number;
  first_fetched_at: number | null;
  last_fetched_at: number | null;
  rows: number;
  retrievals: { slots: Record<string, string>; arguments_sha256: string; fetched_at: number; upstream: Record<string, unknown>; rows_sha256: string; rows: number }[];
  retrievals_omitted: number;
  unreadable: number;
}

/** At most this many calls are quoted one by one; the counts and the agreed pins still cover all of them. */
export const PROVENANCE_CALLS_KEPT = 200;

export function provenanceForShape(home: string, shape: string): ShapeProvenance | null {
  const file = shapeFiles(home, shape).provenance;
  if (!existsSync(file)) return null;
  const out: ShapeProvenance = {
    source: 'mcp', shape, plan_id: null, server: null, tool: null, upstream: {}, upstream_varied: [],
    calls: 0, first_fetched_at: null, last_fetched_at: null, rows: 0, retrievals: [], retrievals_omitted: 0, unreadable: 0,
  };
  let first = true;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: { plan_id?: string; slots?: Record<string, string>; at?: number; provenance?: RowProvenance };
    try { rec = JSON.parse(line) as typeof rec; } catch { out.unreadable += 1; continue; }
    const p = rec.provenance;
    if (!p || typeof p !== 'object') { out.unreadable += 1; continue; }
    out.calls += 1;
    out.rows += p.rows ?? 0;
    out.plan_id ??= rec.plan_id ?? null;
    out.server ??= p.server ?? null;
    out.tool ??= p.tool ?? null;
    const at = p.fetched_at ?? rec.at ?? null;
    if (at !== null) {
      out.first_fetched_at = out.first_fetched_at === null ? at : Math.min(out.first_fetched_at, at);
      out.last_fetched_at = out.last_fetched_at === null ? at : Math.max(out.last_fetched_at, at);
    }
    const up = p.upstream ?? {};
    if (first) { out.upstream = { ...up }; first = false; } else {
      for (const k of Object.keys(out.upstream)) {
        if (!(k in up) || up[k] !== out.upstream[k]) { delete out.upstream[k]; if (!out.upstream_varied.includes(k)) out.upstream_varied.push(k); }
      }
      for (const k of Object.keys(up)) if (!(k in out.upstream) && !out.upstream_varied.includes(k)) out.upstream_varied.push(k);
    }
    if (out.retrievals.length < PROVENANCE_CALLS_KEPT) {
      out.retrievals.push({
        slots: rec.slots ?? {}, arguments_sha256: p.arguments_sha256, fetched_at: at ?? 0,
        upstream: up, rows_sha256: p.rows_sha256, rows: p.rows ?? 0,
      });
    } else out.retrievals_omitted += 1;
  }
  return out.calls ? out : null;
}

export interface ShapeDataset {
  rows: TeachRow[];
  /** Lines read, before de-duplication. */
  lines: number;
  /** Lines that were not JSON (a torn append) — reported, never silently dropped. */
  unreadable: number;
}

/**
 * Everything this shape has retrieved, ready for the teach pipeline: de-duplicated on the node's own prompt key,
 * freshest answer winning, in first-seen order. This is what a bake trains on — the agent compiles what it
 * actually paid for, not a fresh pull nobody checked.
 */
export function datasetForShape(home: string, shape: string): ShapeDataset {
  const file = shapeFiles(home, shape).rows;
  if (!existsSync(file)) return { rows: [], lines: 0, unreadable: 0 };
  const order: string[] = [];
  const by = new Map<string, TeachRow>();
  let lines = 0;
  let unreadable = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let row: TeachRow;
    try { row = JSON.parse(line) as TeachRow; } catch { unreadable++; continue; }
    if (typeof row?.prompt !== 'string' || typeof row?.answer !== 'string') { unreadable++; continue; }
    const key = promptKey(row);
    if (!by.has(key)) order.push(key);
    by.set(key, row);
  }
  return { rows: order.map((k) => by.get(k) as TeachRow), lines, unreadable };
}

// ------------------------------------------------------------------------------------------------ the client

/**
 * The MCP client for a plan's server. The credential is read from the environment variable the plan NAMES — a
 * plan is data and may have been written by somebody else, so it can point at a key and never hold one.
 */
export function sourceForPlan(plan: AgentPlan, env: NodeJS.ProcessEnv = process.env): { source: McpDataSource; authenticated: boolean } {
  const s = plan.server;
  const token = (s.auth_env ?? []).map((name) => env[name]).find((v) => !!v && v.trim() !== '');
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const common = {
    name: s.name,
    timeoutMs: s.timeout_ms ?? 120_000,
    ...(s.max_result_bytes ? { maxResultBytes: s.max_result_bytes } : {}),
    // One reservation, one query. A retry inside the client would spend a query this agent could not account for.
    maxRetries: 0,
    clientName: 'ainize-agent',
  };
  const transport = s.transport === 'stdio'
    ? { kind: 'stdio' as const, command: s.command as string, ...(s.args ? { args: s.args } : {}) }
    : { kind: s.transport, url: s.url as string, ...(headers ? { headers } : {}) };
  return { source: new McpDataSource({ ...common, transport }), authenticated: !!token };
}

// ------------------------------------------------------------------------------------------------ retrieval

export interface RetrieveOptions {
  plan: AgentPlan;
  slots: Record<string, string>;
  /** The agent home. Rows and provenance are kept under `<home>/retrieved`. */
  home: string;
  /**
   * The queries budget, or the explicit string `'unmetered'`. There is no default: a module that can spend
   * somebody's API quota must make the caller say out loud that nothing is limiting it.
   */
  budget: QueryBudget | 'unmetered';
  memory?: RetrieveMemory;
  /** An already-connected source (a warm connection, or a test double). When given, it is not closed here. */
  source?: RetrievalSource;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  locale?: Locale;
  now?: () => number;
}

export interface RetrieveResult {
  plan_id: string;
  shape: string;
  shape_short: string;
  slots: Record<string, string>;
  rows: TeachRow[];
  row_keys: string[];
  /** The first row the plan produced. The plan's query is filtered by the slots, so this is the fact asked for —
   *  and the row's own prompt travels with it, so a wrong match is visible instead of hidden. */
  primary: TeachRow | null;
  new_rows: number;
  refetched: number;
  churned: number;
  queries: number;
  bytes: number;
  ms: number;
  items: number;
  rejected: { index: number; reason: string }[];
  /** Rows whose second phrasing was dropped because another answer claimed the same question. */
  alt_collisions: number;
  /** The complete sealed record, as written to disk. */
  provenance: RowProvenance;
  event: RetrieveEvent;
  rows_file: string;
  provenance_file: string;
  /** Facts held for this shape after this pull. */
  facts_held: number;
  /** `upstream_from` keys the answer did not carry — the rows are not pinned by those. */
  unpinned: string[];
}

/**
 * A second phrasing that two DIFFERENT answers both claim is a contradiction, and the node would train it as one:
 * `alt_prompt` is trained and checked as an alternative form of the question, but `mapRows` de-duplicates on the
 * PROMPT only, so nothing upstream notices. Measured live on 2026-09-07: asking the Uniswap v3 subgraph for
 * `symbol: "WETH"` returns both "Wrapped Ether" and "Wrapped Ether from PulseChain", whose English prompts differ
 * by name and whose Korean alternative was byte-identical — one question, two addresses, in one lesson.
 *
 * The row is kept (its own prompt is unambiguous); only the colliding second phrasing is dropped, and the drop is
 * counted and said out loud.
 */
function dropCollidingAlts(rows: TeachRow[]): { rows: TeachRow[]; collisions: number } {
  const key = (q: string): string => promptKey({ prompt: q, answer: '' });
  const claimed = new Map<string, Set<string>>();
  const claim = (q: string | undefined, answer: string): void => {
    if (!q) return;
    const k = key(q);
    const set = claimed.get(k) ?? new Set<string>();
    set.add(answer);
    claimed.set(k, set);
  };
  for (const r of rows) { claim(r.prompt, r.answer); claim(r.alt_prompt, r.answer); }
  let collisions = 0;
  const out = rows.map((r) => {
    if (!r.alt_prompt || (claimed.get(key(r.alt_prompt))?.size ?? 0) < 2) return r;
    collisions++;
    const { alt_prompt: _dropped, ...rest } = r;
    return rest as TeachRow;
  });
  return { rows: out, collisions };
}

/** Lift the pinning facts out of the SAME response the rows were mapped from. */
function liftUpstream(json: unknown, from: Record<string, string> | undefined): { upstream: Record<string, string | number | boolean>; unpinned: string[] } {
  const upstream: Record<string, string | number | boolean> = {};
  const unpinned: string[] = [];
  for (const [key, path] of Object.entries(from ?? {})) {
    const v = getPath(json, path);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') upstream[key] = v;
    else unpinned.push(key);
  }
  return { upstream, unpinned };
}

/**
 * One plan, one call, one query. Throws only when the retrieval genuinely failed (the budget refused, the server
 * was unreachable, the tool errored, the answer was not JSON) — an empty result is a result and comes back with
 * `rows: []`, because "the query ran and found nothing" is a fact the counters must see.
 */
export async function retrieve(o: RetrieveOptions): Promise<RetrieveResult> {
  const t = translator(RETRIEVE_STRINGS, o.locale);
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => Date.now());
  const bound: BoundPlan = bindPlan(o.plan, o.slots);
  const descriptor = shapeDescriptor(bound);
  const shape = shapeKey(descriptor);

  if (o.budget === 'unmetered') log(t('retrieve.unmetered', { plan: o.plan.id }));
  const hold = o.budget === 'unmetered' ? null : o.budget.reserve('queries', 1, `${o.plan.id} · ${bound.tool}`);

  const own = !o.source;
  let source = o.source ?? null;
  let called = false;
  let settled = false;
  const started = now();
  try {
    if (!source) {
      const built = sourceForPlan(o.plan, o.env);
      if (!built.authenticated && (o.plan.server.auth_env ?? []).length) {
        log(t('retrieve.anonymous', { server: o.plan.server.name, env: (o.plan.server.auth_env ?? []).join(', ') }));
      }
      source = built.source;
      await source.connect();
    }
    called = true;
    const out = await source.call(bound.tool, bound.arguments);
    // The query has left this machine and come back. Whatever happens to the ANSWER from here on, it was spent.
    settled = true;
    hold?.settle(1);
    return finish(out);
  } catch (e) {
    if (called) {
      if (!settled) { settled = true; hold?.settle(1); }
      log(t('retrieve.failedAfterCall', { server: o.plan.server.name, tool: bound.tool, error: (e as Error).message }));
    } else {
      hold?.release();
      log(t('retrieve.failedBeforeCall', { server: o.plan.server.name, error: (e as Error).message }));
    }
    throw e;
  } finally {
    if (own && source) await source.close().catch(() => {});
  }

  function finish(out: McpCallResult): RetrieveResult {
    // The same two refusals `fetchRows` makes, with the same codes: a tool error and a non-JSON answer are not
    // rows, and pretending otherwise would put an error message in a training set.
    if (out.isError) throw new McpDataSourceError(`${bound.tool} answered with an error: ${out.text.slice(0, 400)}`, 'mcp_tool_error');
    if (out.json === null) throw new McpDataSourceError(`${bound.tool} did not answer with JSON, so there is nothing to map (first 200 bytes: ${out.text.slice(0, 200)})`, 'mcp_not_json');

    const lifted = liftUpstream(out.json, o.plan.upstream_from);
    const upstream = { ...bound.upstream, ...lifted.upstream };
    const mapped = mapRows(out.json, bound.mapping);
    const deconflicted = dropCollidingAlts(mapped.rows);
    const head = { ...out.provenance, ...(Object.keys(upstream).length ? { upstream } : {}) };
    const rows = withProvenanceNotes(deconflicted.rows, head, bound.note_fields);
    const provenance = sealProvenance(rows, head);

    const at = now();
    const keys = rows.map((r) => promptKey(r));
    let newRows = 0;
    let refetched = 0;
    let churned = 0;
    const learns: LearnEvent[] = [];
    for (const [i, key] of keys.entries()) {
      const row = rows[i] as TeachRow;
      const known = o.memory?.row(key) ?? null;
      if (!known) {
        newRows++;
        learns.push({ kind: 'learn', row_key: key, answer: row.answer, source: 'retrieval', engram: null, shape });
        continue;
      }
      refetched++;
      if (known.answer !== row.answer) {
        churned++;
        learns.push({ kind: 'learn', row_key: key, answer: row.answer, source: 'retrieval', engram: null, shape });
      }
    }

    mkdirSync(retrievedDir(o.home), { recursive: true, mode: 0o700 });
    writeShapeDescriptor(o.home, shape, descriptor, o.plan.id, at);
    const files = appendRetrieved(o.home, shape, rows, provenance, { plan_id: o.plan.id, slots: bound.slots, at });
    const held = datasetForShape(o.home, shape);

    const event: RetrieveEvent = {
      kind: 'retrieve',
      shape,
      plan_id: o.plan.id,
      arguments_sha256: provenance.arguments_sha256,
      rows: rows.length,
      new_rows: newRows,
      refetched,
      churned,
      queries: 1,
      bytes: out.text.length,
      ms: at - started,
      provenance: capProvenance(provenance, files.provenance_file),
    };
    for (const l of learns) o.memory?.append(l);
    o.memory?.append(event);

    log(t('retrieve.paid', { server: o.plan.server.name, tool: bound.tool, rows: rows.length, refetched, ms: event.ms, queries: 1 }));
    if (!rows.length) {
      log(t('retrieve.empty', {
        tool: bound.tool, items: mapped.items, rejected: mapped.rejected.length,
        reasons: [...new Set(mapped.rejected.map((r) => r.reason.split(':')[0] as string))].join(', ') || '—',
      }));
    }
    if (churned) log(t('retrieve.churn', { churned, refetched }));
    if (deconflicted.collisions) log(t('retrieve.altCollision', { n: deconflicted.collisions }));
    if (lifted.unpinned.length) log(t('retrieve.unpinned', { keys: lifted.unpinned.join(', '), tool: bound.tool }));
    log(t('retrieve.stored', { shape: shortShape(shape), rows: rows.length, file: files.rows_file, total: held.rows.length, provenance: files.provenance_file }));

    return {
      plan_id: o.plan.id, shape, shape_short: shortShape(shape), slots: bound.slots,
      rows, row_keys: keys, primary: rows[0] ?? null,
      new_rows: newRows, refetched, churned, queries: 1, bytes: out.text.length, ms: event.ms,
      items: mapped.items, rejected: mapped.rejected, alt_collisions: deconflicted.collisions, provenance, event,
      rows_file: files.rows_file, provenance_file: files.provenance_file,
      facts_held: held.rows.length, unpinned: lifted.unpinned,
    };
  }
}

// ------------------------------------------------------------------------------------- question → plan, or a no

export type QuestionPlan =
  | { ok: true; candidate: PlanCandidate; alternatives: PlanCandidate[]; refusals: SlotRefusal[] }
  | { ok: false; reason: 'no_plan' | 'slot_refused'; refusals: SlotRefusal[] };

/**
 * Which plan answers this question, if any. A question that matches nothing is NOT retrieved: the caller prints
 * what the agent has and stops, rather than guessing a query with somebody else's key.
 */
export function planForQuestion(plans: AgentPlan[], question: string): QuestionPlan {
  const { matches, refusals } = matchQuestion(plans, question);
  const best = matches[0];
  if (!best) return { ok: false, reason: refusals.length ? 'slot_refused' : 'no_plan', refusals };
  return { ok: true, candidate: best, alternatives: matches.slice(1), refusals };
}

/** The sentences a refusal prints — the plans it has, or the slot it would not send. */
export function explainNoPlan(plans: AgentPlan[], outcome: Extract<QuestionPlan, { ok: false }>, locale?: Locale): string[] {
  const t = translator(RETRIEVE_STRINGS, locale);
  const lines: string[] = [];
  for (const r of outcome.refusals) {
    lines.push(t('retrieve.slotRefused', { plan: r.plan_id, pattern: r.pattern, slot: r.slot, reason: r.reason }));
  }
  lines.push(t('retrieve.noPlan', { plans: plans.length, ids: plans.map((p) => p.id).join(', ') || '—' }));
  return lines;
}
