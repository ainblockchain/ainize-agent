/**
 * The agent's budget and its spend ledger.
 *
 * An agent that buys knowledge, calls somebody else's paid subgraph and submits GPU jobs is spending in FOUR units
 * that do not convert into one another: market currency, upstream queries, daily lessons, and GPU seconds. One of
 * them running out says nothing about the other three, so there is one cap each, and a refusal names which one.
 *
 * Four rules hold the whole thing together:
 *
 *  1. **Check-and-hold.** `reserve()` returns `{ settle, release }` and the amount is held until one of them is
 *     called, so two decisions in flight cannot both squeeze past the same remainder. This is the
 *     `@ngram/mcp` session `Budget.reserve` pattern (money.ts), one day and four units wide.
 *  2. **Intent before the act.** The `intent` line is appended to `spend.jsonl` BEFORE the call it pays for, exactly
 *     as `pending-payments.jsonl` is written before the money moves (agent.ts `appendPending`). A crash between the
 *     two therefore leaves evidence on this machine, and the unfinished reservation is counted AS SPENT on the next
 *     run for the three units where nothing else could tell us — the act may have happened.
 *  3. **A cap comes from outside the loop.** Flags, `NGRAM_AGENT_*` env, or `budget` in `<home>/agent.json`, and
 *     nowhere else. A plan file is data that somebody else may have written; a market answer and a 402 are the other
 *     side of a negotiation. None of them can raise a cap: `caps` is frozen and there is no setter. `max` on one
 *     reservation may only LOWER what that call is allowed.
 *  4. **Refuse, never clamp.** Over the cap is a refusal carrying cap / spent / reserved / remaining and the flag
 *     that would raise it — and then the agent stops. It does not buy something cheaper, trim the lesson, or retry.
 *
 * What is NOT counted here: what was actually PAID. `purchases.jsonl` (agent.ts `spentToday`) stays the authority on
 * that, and the money cap is measured against it, so this ledger never becomes a second, disagreeing set of books.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AmountError, formatAmount, normalizeAmount, parseAmount } from '@ngram/mcp/money';
import { spentToday } from './agent.js';
import { agentLocale, translator, type Locale, type T } from './i18n.js';
import { BUDGET_STRINGS } from './strings/budget.js';

export type BudgetKind = 'money' | 'queries' | 'lessons' | 'gpu_s';
export const BUDGET_KINDS = ['money', 'queries', 'lessons', 'gpu_s'] as const satisfies readonly BudgetKind[];

/** Queries and lessons are counted one at a time; a cap of "0.5 lessons" is not a cap, it is a typo. */
const WHOLE: Record<BudgetKind, boolean> = { money: false, queries: true, lessons: true, gpu_s: false };

/** The flag that raises each cap — quoted in every refusal, because "raise it" is useless without "raise it where". */
export const BUDGET_FLAG: Record<BudgetKind, string> = {
  money: '--budget-per-day',
  queries: '--queries-per-day',
  lessons: '--lessons-per-day',
  gpu_s: '--gpu-seconds-per-day',
};
export const BUDGET_ENV: Record<BudgetKind, string> = {
  money: 'NGRAM_AGENT_BUDGET_PER_DAY',
  queries: 'NGRAM_AGENT_QUERIES_PER_DAY',
  lessons: 'NGRAM_AGENT_LESSONS_PER_DAY',
  gpu_s: 'NGRAM_AGENT_GPU_SECONDS_PER_DAY',
};
/** The key under `budget` in `<home>/agent.json`. */
export const BUDGET_FILE_KEY: Record<BudgetKind, string> = {
  money: 'money_per_day',
  queries: 'queries_per_day',
  lessons: 'lessons_per_day',
  gpu_s: 'gpu_seconds_per_day',
};

// ------------------------------------------------------------------ the day
/** `2026-09-07` — the UTC day `spentToday` already slices purchases on, so both budgets roll over together. */
export function dayKey(now = Date.now()): string { return new Date(now).toISOString().slice(0, 10); }
export function dayStart(now = Date.now()): number { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
export function resetsAt(now = Date.now()): number { return dayStart(now) + 86_400_000; }
/** `2026-09-08 00:00 UTC` — the wording the node's own quota refusals end with (teach.ts `resetLabel`). */
export function resetLabel(at: number): string { return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`; }

// ------------------------------------------------------------------ caps
export interface CapSource { via: 'flag' | 'env' | 'file'; origin: string }
export interface ResolvedCap { amount: string | null; source: CapSource | null }
export interface ResolvedCaps {
  money: ResolvedCap; queries: ResolvedCap; lessons: ResolvedCap; gpu_s: ResolvedCap;
  /** Where a `file` cap would be read from, quoted in the "no cap set" refusal even when the file does not exist. */
  file: string;
}

/** Caps as the CLI collects them. Every value is optional; an absent one falls through to env, then to agent.json. */
export interface CapFlags { money?: string | number; queries?: string | number; lessons?: string | number; gpu_s?: string | number }

export function agentConfigFile(home: string): string { return join(home, 'agent.json'); }

interface AgentConfigFile { budget?: Record<string, string | number | undefined> }

function readAgentConfig(home: string): AgentConfigFile {
  const f = agentConfigFile(home);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')) as AgentConfigFile; } catch { return {}; }
}

/**
 * Resolve the four caps, in the only three places a cap may come from: flags, then env, then `<home>/agent.json`.
 * An unresolvable cap is `null` — NOT a default. There is no number this module could pick that would be honest,
 * and an agent with no budget for a unit simply refuses to spend that unit on its own.
 */
export function loadCaps(o: { home: string; flags?: CapFlags; env?: NodeJS.ProcessEnv; locale?: Locale }): ResolvedCaps {
  const env = o.env ?? process.env;
  const file = readAgentConfig(o.home).budget ?? {};
  const t = translator(BUDGET_STRINGS, o.locale ?? agentLocale(env));
  const out = { file: agentConfigFile(o.home) } as ResolvedCaps;
  for (const kind of BUDGET_KINDS) {
    const raw = o.flags?.[kind] !== undefined
      ? { value: o.flags[kind] as string | number, source: { via: 'flag' as const, origin: BUDGET_FLAG[kind] } }
      : env[BUDGET_ENV[kind]] !== undefined
        ? { value: env[BUDGET_ENV[kind]] as string, source: { via: 'env' as const, origin: BUDGET_ENV[kind] } }
        : file[BUDGET_FILE_KEY[kind]] !== undefined
          ? { value: file[BUDGET_FILE_KEY[kind]] as string | number, source: { via: 'file' as const, origin: agentConfigFile(o.home) } }
          : null;
    if (!raw) { out[kind] = { amount: null, source: null }; continue; }
    let amount: string;
    try {
      amount = normalizeAmount(raw.value, BUDGET_FILE_KEY[kind]);
      if (WHOLE[kind] && !/^\d+$/.test(amount)) throw new AmountError(`${BUDGET_FILE_KEY[kind]} is counted one at a time`);
    } catch (e) {
      // Named by the cap's own key, not by its unit: the currency is not known yet at load time, so "the AIN cap"
      // would be a guess printed at the one moment the operator is already being told they got something wrong.
      throw new Error(t('bad_cap', { key: BUDGET_FILE_KEY[kind], origin: raw.source.origin, value: String(raw.value), detail: (e as Error).message }));
    }
    out[kind] = { amount, source: raw.source };
  }
  return out;
}

function unitWord(t: T<typeof BUDGET_STRINGS>, kind: BudgetKind, currency: string): string {
  return t(`unit_${kind}`, { currency });
}
function sourceWord(t: T<typeof BUDGET_STRINGS>, s: CapSource | null): string {
  return s ? t(`source_${s.via}`, { origin: s.origin }) : t('source_node', {});
}

// ------------------------------------------------------------------ the ledger file
export type SpendEvent = 'intent' | 'settle' | 'release' | 'refused';

/**
 * One line of `<home>/spend.jsonl`. Deliberately small: the log is appended from more than one process (a `watch`
 * loop and an `ask` can both be running) and single-line `O_APPEND` atomicity is only safe well under a pipe buffer,
 * so `note`/`ref` are truncated rather than trusted.
 */
export interface SpendRow {
  v: 1;
  /** Links `intent` to the `settle` or `release` that closed it. */
  id: string;
  kind: BudgetKind;
  event: SpendEvent;
  /** Reserved (intent), actually spent (settle), reserved-and-given-back (release), asked for (refused). */
  amount: string;
  at: number;
  day: string;
  /** What the unit was for, in one word: `buy`, `mcp_call`, `teach_job`, `teach_gpu`. */
  act: string;
  currency?: string;
  ref?: string;
  note?: string;
  /** `release` only — why it came back. `refused` only — the refusal code. */
  reason?: string;
}

export function spendFile(home: string): string { return join(home, 'spend.jsonl'); }

/** Every line this agent has written, oldest first. A half-written line is not a spend and is skipped. */
export function readSpend(home: string): SpendRow[] {
  const f = spendFile(home);
  if (!existsSync(f)) return [];
  const out: SpendRow[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SpendRow;
      if (r && typeof r.id === 'string' && typeof r.at === 'number') out.push(r);
    } catch { /* a torn line is not a spend */ }
  }
  return out;
}

function appendSpend(home: string, row: SpendRow): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(spendFile(home), JSON.stringify(row) + '\n', { mode: 0o600 });
}

const clip = (s: string | undefined, n: number): string | undefined => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ refusals
export type RefusalCode = 'no_cap' | 'over_cap' | 'node_cap' | 'per_call' | 'not_whole' | 'bad_amount';

/** What a refusal needs to name its unit and its cap's origin in whichever language it is asked for. */
interface RefusalContext { currency: string; capSource: CapSource | null }

function renderRefusal(key: keyof typeof BUDGET_STRINGS & string, vars: Record<string, string | number>, kind: BudgetKind, ctx: RefusalContext, locale: Locale): string {
  const t = translator(BUDGET_STRINGS, locale);
  return t(key, { ...vars, unit: unitWord(t, kind, ctx.currency), source: sourceWord(t, ctx.capSource) });
}

/**
 * A refusal the agent stops on. It carries the four numbers and the flag in `details` so `--json` keeps them, and
 * renders its sentence in either language — the CLI's locale is not the only reader (a log shipped to somebody else
 * may want the other one).
 *
 * `vars` therefore holds NOTHING that was already translated. The first cut interpolated the unit noun and the
 * "set by --flag" clause at construction time, so `render('ko')` on a refusal raised in an English process handed
 * back a Korean sentence with `upstream queries` and `set by --queries-per-day` still in it.
 */
export class BudgetRefusal extends Error {
  readonly name = 'BudgetRefusal';
  private readonly key: keyof typeof BUDGET_STRINGS & string;
  private readonly vars: Record<string, string | number>;
  private readonly ctx: RefusalContext;
  constructor(
    readonly code: RefusalCode,
    readonly kind: BudgetKind,
    /** The flag that would raise this cap, or `null` when nothing on this side can — the node owns the limit. */
    readonly flag: string | null,
    readonly details: Record<string, unknown>,
    key: keyof typeof BUDGET_STRINGS & string,
    vars: Record<string, string | number>,
    ctx: RefusalContext,
    locale: Locale,
  ) {
    super(renderRefusal(key, vars, kind, ctx, locale));
    this.key = key;
    this.vars = vars;
    this.ctx = ctx;
  }
  render(locale: Locale): string { return renderRefusal(this.key, this.vars, this.kind, this.ctx, locale); }
}

// ------------------------------------------------------------------ views
export interface BudgetView {
  kind: BudgetKind;
  unit: string;
  currency?: string;
  /** The cap you set. `null` = none set; this agent will not spend this unit on its own. */
  cap: string | null;
  cap_source: CapSource | null;
  /** A second ceiling the node imposes (lessons: `jobs_per_key_per_day`). */
  node_cap: string | null;
  node_source: string | null;
  /** The tighter of the two — what `reserve` actually measures against. */
  effective_cap: string | null;
  spent: string;
  reserved: string;
  remaining: string | null;
  /** Reservations from an earlier run that were never settled or released. */
  unresolved: { count: number; amount: string; counted_as_spent: boolean };
  flag: string;
  day: string;
  resets_at: number;
}

export interface Hold {
  readonly id: string;
  readonly kind: BudgetKind;
  /** What was held. `settle()` may report a different actual. */
  readonly amount: string;
  readonly open: boolean;
  /** Close the hold at what it really cost. Returns the settled amount. */
  settle(actual?: string | number, note?: string): string;
  /** Give it back untouched — the act never happened (a node that refused a job never queued it). */
  release(reason: string): void;
}

export interface ReserveRequest {
  kind: BudgetKind;
  amount: string | number;
  /** One word for the ledger and the refusal: `buy`, `mcp_call`, `teach_job`, `teach_gpu`. */
  act: string;
  ref?: string;
  note?: string;
  /** Money only — the seller's currency. The cap is applied per currency, as `watch` already applies it (agent.ts). */
  currency?: string;
  /** A ceiling for this ONE call. May only lower what the budget allows; it can never raise a cap. */
  max?: string | number;
  /** Named in a node-quota refusal so the sentence says which node's limit it was. */
  market?: string;
}

interface Snapshot {
  settled: Record<BudgetKind, bigint>;
  unresolved: Record<BudgetKind, { count: number; amount: bigint }>;
}

const zeroSnapshot = (): Snapshot => ({
  settled: { money: 0n, queries: 0n, lessons: 0n, gpu_s: 0n },
  unresolved: { money: { count: 0, amount: 0n }, queries: { count: 0, amount: 0n }, lessons: { count: 0, amount: 0n }, gpu_s: { count: 0, amount: 0n } },
});

/**
 * Four daily caps over one append-only ledger.
 *
 * Every read re-replays today's `spend.jsonl` rather than trusting an in-memory total, so a second agent process
 * writing to the same home is seen. This process's own OPEN holds are skipped in that replay and counted as
 * `reserved` instead, which is the only place the two could double.
 */
export class AgentBudget {
  private readonly holds = new Map<string, { kind: BudgetKind; amount: bigint }>();
  private nodeLesson: { limit: string; source: string } | null = null;
  private readonly t: T<typeof BUDGET_STRINGS>;

  constructor(
    readonly home: string,
    readonly caps: ResolvedCaps,
    private readonly opts: { currency?: string; locale?: Locale; now?: () => number } = {},
  ) {
    Object.freeze(this.caps);
    for (const k of BUDGET_KINDS) Object.freeze(this.caps[k]);
    this.t = translator(BUDGET_STRINGS, this.locale);
  }

  static open(o: { home: string; flags?: CapFlags; env?: NodeJS.ProcessEnv; currency?: string; locale?: Locale; now?: () => number }): AgentBudget {
    const locale = o.locale ?? agentLocale(o.env ?? process.env);
    return new AgentBudget(o.home, loadCaps({ home: o.home, flags: o.flags, env: o.env, locale }), { currency: o.currency, locale, now: o.now });
  }

  get locale(): Locale { return this.opts.locale ?? agentLocale(); }
  /** The currency the money cap is denominated in when a call does not name one. Matches `@ngram/mcp`'s own default. */
  get currency(): string { return this.opts.currency ?? 'AIN'; }
  private get now(): number { return (this.opts.now ?? Date.now)(); }

  /**
   * The node's own per-key daily lesson limit (`GET /api/teach/policy` → `limits.jobs_per_key_per_day`), applied as
   * a SECOND ceiling. The tighter of the two wins, and this can only ever tighten: an answer from a market is not
   * allowed to raise a cap the owner set, and a second, laxer node does not undo a first, stricter one.
   */
  applyNodeLessonLimit(limit: number | string, source: string): void {
    // A limit that is not a number throws rather than being quietly dropped: a ceiling the agent silently failed to
    // apply is exactly the failure this second ceiling exists to prevent.
    const v = normalizeAmount(limit, 'jobs_per_key_per_day');
    if (!this.nodeLesson || parseAmount(v) < parseAmount(this.nodeLesson.limit)) this.nodeLesson = { limit: v, source };
  }

  // ---------------------------------------------------------------- accounting
  private snapshot(): Snapshot {
    const start = dayStart(this.now);
    const end = start + 86_400_000;
    const rows = readSpend(this.home).filter((r) => r.at >= start && r.at < end);
    const opened = new Map<string, SpendRow>();
    const snap = zeroSnapshot();
    for (const r of rows) {
      if (this.holds.has(r.id)) continue;   // mine and still open — counted as `reserved`, not twice
      if (r.event === 'intent') { opened.set(r.id, r); continue; }
      if (r.event === 'settle') {
        opened.delete(r.id);
        // An intent opened before midnight settles today. Charging the day the money actually moved is the only
        // reading that keeps "today's cap" true; the alternative back-dates a cost into a day already closed.
        try { snap.settled[r.kind] += parseAmount(r.amount); } catch { /* an unreadable amount is not a spend */ }
        continue;
      }
      if (r.event === 'release') { opened.delete(r.id); continue; }
      // 'refused' is a record, never an amount
    }
    for (const r of opened.values()) {
      try { const a = parseAmount(r.amount); snap.unresolved[r.kind].count += 1; snap.unresolved[r.kind].amount += a; } catch { /* ignore */ }
    }
    return snap;
  }

  private spentBig(kind: BudgetKind, snap: Snapshot, currency: string): bigint {
    if (kind === 'money') {
      // purchases.jsonl is the authority on what was PAID (agent.ts `spentToday`). An unfinished payment intent is
      // NOT added on top: either the purchase landed and is already in that file, or the x402 payment has no
      // manifest yet and `pending-payments.jsonl` re-presents it on the next run instead of paying again.
      const n = spentToday(this.home, this.now)[currency] ?? 0;
      const s = Number.isFinite(n) ? n.toFixed(9) : '0';
      return parseAmount(s.replace(/^-.*/, '0'));
    }
    // Nothing else can tell us whether the act happened, so an unfinished reservation is charged at what it held.
    return snap.settled[kind] + snap.unresolved[kind].amount;
  }

  private reservedBig(kind: BudgetKind): bigint {
    let n = 0n;
    for (const h of this.holds.values()) if (h.kind === kind) n += h.amount;
    return n;
  }

  /** The tighter of the owner's cap and the node's, as a scaled BigInt; `null` when no cap is set at all. */
  private effectiveBig(kind: BudgetKind): { cap: bigint; bound: 'own' | 'node' } | null {
    const own = this.caps[kind].amount;
    const node = kind === 'lessons' ? this.nodeLesson?.limit ?? null : null;
    if (own === null) return null;
    const o = parseAmount(own);
    if (node === null) return { cap: o, bound: 'own' };
    const n = parseAmount(node);
    return n < o ? { cap: n, bound: 'node' } : { cap: o, bound: 'own' };
  }

  view(kind: BudgetKind, currency = this.currency): BudgetView {
    const snap = this.snapshot();
    const spent = this.spentBig(kind, snap, currency);
    const reserved = this.reservedBig(kind);
    const eff = this.effectiveBig(kind);
    const un = snap.unresolved[kind];
    return {
      kind,
      unit: unitWord(this.t, kind, currency),
      ...(kind === 'money' ? { currency } : {}),
      cap: this.caps[kind].amount,
      cap_source: this.caps[kind].source,
      node_cap: kind === 'lessons' ? this.nodeLesson?.limit ?? null : null,
      node_source: kind === 'lessons' ? this.nodeLesson?.source ?? null : null,
      effective_cap: eff ? formatAmount(eff.cap) : null,
      spent: formatAmount(spent),
      reserved: formatAmount(reserved),
      remaining: eff ? formatAmount(eff.cap - spent - reserved) : null,
      unresolved: { count: un.count, amount: formatAmount(un.amount), counted_as_spent: kind !== 'money' },
      flag: BUDGET_FLAG[kind],
      day: dayKey(this.now),
      resets_at: resetsAt(this.now),
    };
  }

  views(currency = this.currency): BudgetView[] { return BUDGET_KINDS.map((k) => this.view(k, currency)); }

  /** One line per unit for `agent budget`, in the agent's locale. */
  lines(currency = this.currency): string[] { return BUDGET_KINDS.map((k) => this.probe(k, 0, currency).line); }

  /**
   * Would this reservation fit? Reserves nothing, writes nothing, holds nothing — a gate that only asks.
   *
   * It is deliberately NOT a substitute for `reserve()`: between an `ok: true` here and the reservation, another
   * process can take the remainder. `reserve()` is the decision; this is what a report prints.
   */
  probe(kind: BudgetKind, amount: string | number, currency = this.currency): { ok: boolean; line: string; view: BudgetView } {
    const view = this.view(kind, currency);
    let ok = false;
    try {
      const want = parseAmount(normalizeAmount(amount, kind));
      const eff = this.effectiveBig(kind);
      ok = want === 0n || (!!eff && want <= eff.cap - this.spentBig(kind, this.snapshot(), currency) - this.reservedBig(kind));
    } catch { ok = false; }
    const line = view.cap === null
      ? this.t('line_no_cap', { unit: view.unit, flag: view.flag })
      : view.node_cap !== null
        ? this.t('line_node_capped', { unit: view.unit, spent: view.spent, reserved: view.reserved, remaining: view.remaining ?? '0', cap: view.effective_cap ?? '0', own_cap: view.cap, node_cap: view.node_cap, market: view.node_source ?? '' })
        : this.t('line_capped', { unit: view.unit, spent: view.spent, reserved: view.reserved, remaining: view.remaining ?? '0', cap: view.cap, source: sourceWord(this.t, view.cap_source) });
    return { ok, line, view };
  }

  // ---------------------------------------------------------------- the check-and-hold
  /**
   * Hold `amount` of `kind` for the act about to happen, writing the intent line first. Throws `BudgetRefusal` and
   * changes nothing when it does not fit — the caller stops, it does not ask for less.
   */
  reserve(req: ReserveRequest): Hold {
    const kind = req.kind;
    const currency = req.currency ?? this.currency;
    const act = req.act;

    let want: bigint;
    let wantStr: string;
    try {
      wantStr = normalizeAmount(req.amount, kind);
      want = parseAmount(wantStr);
    } catch (e) {
      throw this.refuse('bad_amount', kind, BUDGET_FLAG[kind], { needed: String(req.amount), act }, 'refuse_bad_amount', { needed: String(req.amount), act, detail: (e as Error).message }, currency);
    }
    if (WHOLE[kind] && !/^\d+$/.test(wantStr)) {
      throw this.refuse('not_whole', kind, BUDGET_FLAG[kind], { needed: wantStr, act }, 'refuse_not_whole', { needed: wantStr, act }, currency);
    }

    // Zero always fits, and fits even with no cap set: a knowledge the seller gives away costs nothing, and a
    // lesson on the stub backend burns no GPU second. There is nothing there for a cap to be a cap of.
    const eff = this.effectiveBig(kind);
    if (!eff && want > 0n) {
      this.record({ kind, event: 'refused', amount: wantStr, act, ref: req.ref, currency: kind === 'money' ? currency : undefined, reason: 'no_cap', id: newId() });
      throw this.refuse('no_cap', kind, BUDGET_FLAG[kind], { needed: wantStr, act }, 'refuse_no_cap', {
        act, needed: wantStr, flag: BUDGET_FLAG[kind], env: BUDGET_ENV[kind], key: BUDGET_FILE_KEY[kind], file: this.caps.file,
      }, currency);
    }

    if (req.max !== undefined) {
      const max = parseAmount(normalizeAmount(req.max, 'max'));
      if (want > max) {
        throw this.refuse('per_call', kind, null, { needed: wantStr, max: formatAmount(max), act }, 'refuse_per_call', { needed: wantStr, max: formatAmount(max), act }, currency);
      }
    }

    const snap = this.snapshot();
    const spent = this.spentBig(kind, snap, currency);
    const reserved = this.reservedBig(kind);
    const remaining = eff ? eff.cap - spent - reserved : 0n;
    if (eff && want > remaining) {
      const v = this.view(kind, currency);
      const capStr = formatAmount(eff.cap);
      const common = { needed: wantStr, cap: capStr, spent: v.spent, reserved: v.reserved, remaining: v.remaining ?? '0', act, resets_at: v.resets_at };
      this.record({ kind, event: 'refused', amount: wantStr, act, ref: req.ref, currency: kind === 'money' ? currency : undefined, reason: eff.bound === 'node' ? 'node_cap' : 'over_cap', id: newId() });
      if (eff.bound === 'node') {
        throw this.refuse('node_cap', kind, null, { ...common, node_cap: this.nodeLesson?.limit ?? null, own_cap: this.caps[kind].amount }, 'refuse_node_cap', {
          act, needed: wantStr, node_cap: this.nodeLesson?.limit ?? '0', cap: this.caps[kind].amount ?? '0',
          spent: v.spent, reserved: v.reserved, remaining: v.remaining ?? '0',
          market: req.market ?? this.nodeLesson?.source ?? 'this node', flag: BUDGET_FLAG[kind], resets: resetLabel(v.resets_at),
        }, currency);
      }
      throw this.refuse('over_cap', kind, BUDGET_FLAG[kind], common, 'refuse_over_cap', {
        act, needed: wantStr, cap: capStr, spent: v.spent, reserved: v.reserved, remaining: v.remaining ?? '0',
        flag: BUDGET_FLAG[kind], resets: resetLabel(v.resets_at),
      }, currency);
    }

    // Intent BEFORE the act, so a crash in the middle leaves evidence on this machine and not only on the chain.
    const id = newId();
    this.record({ id, kind, event: 'intent', amount: wantStr, act, ref: req.ref, note: req.note, currency: kind === 'money' ? currency : undefined });
    this.holds.set(id, { kind, amount: want });

    const self = this;
    return {
      id, kind, amount: wantStr,
      // Liveness lives in the map, not in a closure flag: `releaseAll()` must really close a hold whose handle the
      // caller is still holding, and a settle after that must be a no-op rather than a second row for one act.
      get open() { return self.holds.has(id); },
      settle(actual?: string | number, note?: string): string {
        if (!self.holds.has(id)) return wantStr;
        self.holds.delete(id);
        // A settle bigger than its hold is recorded in full — the unit was spent. It eats into what is left today
        // rather than being clamped, and the next reserve simply sees a smaller remainder.
        const paid = actual === undefined ? wantStr : normalizeAmount(actual, kind);
        self.record({ id, kind, event: 'settle', amount: paid, act, ref: req.ref, note, currency: kind === 'money' ? currency : undefined });
        return paid;
      },
      release(reason: string): void {
        if (!self.holds.has(id)) return;
        self.holds.delete(id);
        self.record({ id, kind, event: 'release', amount: wantStr, act, ref: req.ref, reason, currency: kind === 'money' ? currency : undefined });
      },
    };
  }

  /** Release every hold this process still has open — for a caller that is giving up cleanly. */
  releaseAll(reason: string): void {
    for (const [id, h] of [...this.holds]) {
      this.holds.delete(id);
      this.record({ id, kind: h.kind, event: 'release', amount: formatAmount(h.amount), act: 'abort', reason });
    }
  }

  private record(r: Omit<SpendRow, 'v' | 'at' | 'day'>): void {
    const at = this.now;
    appendSpend(this.home, {
      v: 1, ...r, at, day: dayKey(at),
      ref: clip(r.ref, 128), note: clip(r.note, 200), reason: clip(r.reason, 200),
    });
  }

  private refuse(code: RefusalCode, kind: BudgetKind, flag: string | null, details: Record<string, unknown>, key: keyof typeof BUDGET_STRINGS & string, vars: Record<string, string | number>, currency: string): BudgetRefusal {
    return new BudgetRefusal(code, kind, flag, { ...details, kind, flag, ...(kind === 'money' ? { currency } : {}) }, key, vars, { currency, capSource: this.caps[kind].source }, this.locale);
  }
}

function newId(): string { return `r_${randomBytes(6).toString('hex')}`; }

// ------------------------------------------------------------------ what one lesson costs in GPU seconds
export interface GpuWorstCase { seconds: string; via: 'flag' | 'policy'; origin: string }

/**
 * How many GPU seconds to hold for one lesson.
 *
 * The design's answer is `teach.trainer.timeoutMs / 1000` — the worst case the node itself allows, since the trainer
 * is killed at that timeout (teach.ts kills the child on `c.trainer.timeoutMs`). The catch, stated rather than
 * papered over: `GET /api/teach/policy` does NOT publish it today — `TeachPolicyView.limits` (teach.ts) carries the
 * row and dataset caps and `timing`, and no trainer timeout — so unless a node starts reporting
 * `limits.trainer_timeout_s`, the number has to be given explicitly and a bake with neither must refuse rather than
 * invent one. `timing.p50_s` is deliberately NOT used: a median is not a worst case, and it is null on a stub node.
 */
export function trainerWorstCaseSeconds(policy: unknown, explicitSeconds?: string | number): GpuWorstCase | null {
  if (explicitSeconds !== undefined) return { seconds: normalizeAmount(explicitSeconds, 'gpu_seconds_per_lesson'), via: 'flag', origin: '--gpu-seconds-per-lesson' };
  const limits = (policy as { limits?: Record<string, unknown> } | null)?.limits;
  const v = limits?.trainer_timeout_s;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { seconds: normalizeAmount(v.toFixed(9), 'trainer_timeout_s'), via: 'policy', origin: 'GET /api/teach/policy limits.trainer_timeout_s' };
  return null;
}
