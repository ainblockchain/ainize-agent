/**
 * The loop — the whole point of the thing.
 *
 *     a question arrives
 *       → can I answer it from the memory I already carry?     yes: answer. no query, no cost.
 *       → no: is there a LISTED knowledge that covers it?      yes: buy it, apply it, and KEEP it.
 *       → no: ask upstream through the MCP client.             slow, and it costs a query EVERY time.
 *            → have I now looked this SHAPE up often enough?
 *                 → yes: AINIZE IT. Build a dataset out of what was retrieved, run it through teach,
 *                        and keep the engram in this agent's own memory.
 *
 * Everything expensive on the right-hand side already existed before this file: `runAgent` buys, verifies and
 * applies (`agent.ts`), `McpDataSource` retrieves (`@ngram/mcp/client`), `runTeachLesson` teaches. What `ask` adds
 * is the left column — a memory to consult first, a counter that notices repetition, a budget with four units, and
 * the arrows between them.
 *
 * Three rules it never breaks:
 *
 *  1. **The model is not part of the decision.** Recall, plan matching, the shape key and the bake trigger are all
 *     decided from files and arithmetic. The only completion in an `ask` is the answer itself, and there is at most
 *     one of them per state of the model.
 *  2. **Nothing is restored.** `runAgent` is called with `keep: true`, because accumulation is the entire premise:
 *     a knowledge this agent bought stays on the model and stays in its memory.
 *  3. **A refusal is final.** When a budget says no, the loop stops and says so with the arithmetic. It does not
 *     buy something cheaper, trim the lesson or try again.
 */
import type { CatalogEntry } from '@ngram/core';
import {
  askModelDetailed, fetchCatalog, pickPatch, purchasesFile, readPurchases, runAgent,
  type AgentOptions, type AgentResult,
} from './agent.js';
import { AgentBudget, BudgetRefusal, type BudgetView, type CapFlags } from './budget.js';
import { shouldBake, type BakeDecision, type BakePolicy, type BakeRun, type BudgetProbe } from './bake.js';
import { agentLocale, translator, type Locale } from './i18n.js';
import { agentHome } from './identity.js';
import {
  AgentMemory, answerMatches, fetchRuntime, rowKey,
  type MemoryShapeView, type ReconcileReport, type RecallView, type RuntimeView,
} from './memory.js';
import { RETRIEVE_STRINGS } from './strings/retrieve.js';
import { LOOP_STRINGS } from './strings/loop.js';

/**
 * `retrieve.ts` and `bake.ts` are reached through a DYNAMIC import, and that is not styling.
 *
 * Both pull `@ngram/mcp/client`, which pulls the MCP SDK. A question answered from memory must not pay for a
 * network client it never opens — that is the whole claim being made about compiled memory — so the modules that
 * speak to somebody else's server are loaded only on the branch that actually speaks to one. The types are
 * imported statically, so nothing here is untyped.
 */
type RetrieveModule = typeof import('./retrieve.js');
type BakeRunModule = typeof import('./bake.js');

export interface AskOptions {
  question: string;
  market: string;
  home?: string;
  /** Serving API; default whatever the market node reports at `/api/runtime`. */
  api?: string;
  /** Apply what it buys or bakes into this runtime repo (existing `runAgent` semantics). */
  repo?: string;
  plans?: string[];
  /** The four daily caps, from flags. Env and `<home>/agent.json` fill in the rest; nothing inside the loop can. */
  caps?: CapFlags;
  bakeAfter?: number | null;
  maxChurn?: number;
  maxPrice?: number;
  maxTokens?: number;
  /** Turn one step off without turning the loop off. All three default to on. */
  buy?: boolean;
  retrieve?: boolean;
  bake?: boolean;
  pay?: AgentOptions['pay'];
  ainProvider?: string;
  privateKey?: string;
  /** GPU seconds to hold for one lesson — the trainer's worst case, which the node does not publish today. */
  gpuSecondsPerLesson?: string | number;
  locale?: Locale;
  now?: () => number;
}

export type AskVia = 'memory' | 'model' | 'knowledge' | 'retrieval' | null;

export interface AskResult {
  question: string;
  row_key: string;
  answer: string | null;
  via: AskVia;
  engram: string | null;
  shape: string | null;
  stack_fp: string | null;
  /** What this one question actually spent. Every number is measured, none is estimated. */
  cost: { completions: number; queries: number; money: string | null; currency: string | null; lessons: number; gpu_s: string | null; ms: number };
  recall: RecallView;
  reconcile: ReconcileReport;
  runtime: { ok: boolean; model: string | null; api: string | null; layers: number; error?: string };
  bought: AgentResult | null;
  retrieved: import('./retrieve.js').RetrieveResult | null;
  bake: { decision: BakeDecision; result: BakeRun | null } | null;
  budget: BudgetView[];
  refusal: { kind: string; code: string; flag: string | null; message: string } | null;
  steps: string[];
  outcome: 'memory' | 'model' | 'knowledge' | 'retrieval' | 'unanswered' | 'refused';
  success: boolean;
}

/** Only `already_known` and `loaded` mean the knowledge is on the model; `ask` does not treat a download as an answer. */
const boughtAndLoaded = (r: AgentResult): boolean => r.outcome === 'loaded' || r.applied;

export async function ask(o: AskOptions, log: (line: string) => void = () => {}): Promise<AskResult> {
  const started = (o.now ?? Date.now)();
  const market = o.market.replace(/\/+$/, '');
  const home = agentHome(o.home);
  const locale = o.locale ?? agentLocale();
  const t = translator({ ...RETRIEVE_STRINGS, ...LOOP_STRINGS }, locale);
  const steps: string[] = [];
  const say = (line: string): void => { steps.push(line); log(line); };

  const memory = AgentMemory.open(home, ...(o.now ? [{ now: o.now }] : []));
  const budget = AgentBudget.open({ home, locale, ...(o.caps ? { flags: o.caps } : {}), ...(o.now ? { now: o.now } : {}) });
  const cost = { completions: 0, queries: 0, money: null as string | null, currency: null as string | null, lessons: 0, gpu_s: null as string | null, ms: 0 };

  say(t('ask.question', { question: o.question }));

  // ---------------------------------------------------------------- [0] what is on the model, and does it agree?
  const runtime: RuntimeView = await fetchRuntime(market, o.now ? { now: o.now() } : {});
  const purchases = readPurchases(home).map((p) => ({ patch_id: p.patch_id, sha256: p.sha256, at: p.at }));
  const reconcile = memory.reconcile(runtime, { purchases });
  for (const line of reconcile.lines) say('    ' + line);
  const api = o.api ?? runtime.api ?? null;
  /**
   * "Is there a model to ask?" is the node's answer, not the presence of a URL.
   *
   * `GET /api/runtime` reports the configured serving API even when it cannot reach it (`available: false`,
   * `error: "serving API unreachable"`). Taking the URL as proof of a model sent recall down the confirm branch
   * against a dead endpoint, and a remembered answer was then thrown away for a completion that could never happen.
   * An explicit `--api` is the caller's word and is trusted; a URL the node itself says is dark is not.
   */
  const hasModel = !!api && (o.api !== undefined || runtime.available !== false);
  const stackFp = runtime.stack_fp;

  const base = {
    question: o.question, row_key: rowKey(o.question), stack_fp: stackFp, reconcile,
    runtime: { ok: runtime.ok, model: runtime.model, api, layers: runtime.stack.length, ...(runtime.error ? { error: runtime.error } : {}) },
    steps,
  };
  const finish = (r: Omit<AskResult, keyof typeof base | 'cost' | 'budget'>): AskResult => {
    cost.ms = (o.now ?? Date.now)() - started;
    memory.flush();
    return { ...base, ...r, cost, budget: budget.views() };
  };

  // ---------------------------------------------------------------- [1] recall — zero completions to decide
  const recall = memory.recall(o.question, { stackFp, hasModel });
  say('[1] ' + recall.line);

  if (recall.decision === 'cache' && recall.answer) {
    memory.recordRecall({ row_key: recall.row_key, shape: recall.shape, hit: true, via: 'memory', engram: recall.engram, stack_fp: stackFp, ms: 0, answer: recall.answer });
    say('    ' + t('ask.answer.memory', { engram: recall.engram ?? 'memory', date: new Date(recall.learned_at ?? 0).toISOString().slice(0, 10) }));
    return finish({ answer: recall.answer, via: 'memory', engram: recall.engram, shape: recall.shape, recall, bought: null, retrieved: null, bake: null, refusal: null, outcome: 'memory', success: true });
  }

  if (recall.decision === 'offline' && recall.answer) {
    memory.recordRecall({ row_key: recall.row_key, shape: recall.shape, hit: true, via: 'memory', engram: recall.engram, stack_fp: stackFp, ms: 0, answer: recall.answer });
    say('    ' + t('ask.answer.memory', { engram: recall.engram ?? 'memory', date: new Date(recall.learned_at ?? 0).toISOString().slice(0, 10) }));
    return finish({ answer: recall.answer, via: 'memory', engram: recall.engram, shape: recall.shape, recall, bought: null, retrieved: null, bake: null, refusal: null, outcome: 'memory', success: true });
  }

  if (recall.decision === 'confirm' && recall.answer && api) {
    // ONE completion. It is both the check and the answer — memory is a claim, the model is the truth.
    try {
      const got = await askModelDetailed(api, o.question, o.maxTokens ?? 8);
      cost.completions += 1;
      const hit = answerMatches(recall.answer, got.text);
      memory.recordRecall({
        row_key: recall.row_key, shape: recall.shape, hit, via: 'model', engram: recall.engram, stack_fp: stackFp,
        ms: got.elapsed_ms, ...(got.usage.total_tokens !== null ? { tokens: got.usage.total_tokens } : {}), ...(hit ? { answer: got.text } : {}),
      });
      if (hit) {
        say('    ' + t('ask.answer.model', { ms: got.elapsed_ms, tokens: got.usage.total_tokens === null ? '' : `, tokens ${got.usage.total_tokens}` }));
        return finish({ answer: got.text, via: 'model', engram: recall.engram, shape: recall.shape, recall, bought: null, retrieved: null, bake: null, refusal: null, outcome: 'model', success: true });
      }
      // A mismatch is not an error. The row is demoted where it stands (the `recall` event does it) and the loop
      // falls through to the cost path, which is what the memory turned out not to cover.
      say('    ' + t('ask.answer.model', { ms: got.elapsed_ms, tokens: '' }));
      say('    ' + t('ask.model.mismatch', { got: JSON.stringify(got.text), remembered: JSON.stringify(recall.answer) }));
    } catch (e) {
      /*
       * The confirming completion could not be made. That is not a reason to forget the answer: memory held it,
       * nothing has contradicted it, and the fingerprint says the model has not changed since it was checked. So
       * the remembered answer is returned with the label that travels with it — `via: 'memory'` — exactly as it
       * would be with no serving model at all (§4, arm C's offline claim). Throwing it away and paying for a
       * lookup instead would be paying twice for a fact this agent already has.
       */
      say('    ' + t('ask.model.unreachable', { why: (e as Error).message }));
      memory.recordRecall({ row_key: recall.row_key, shape: recall.shape, hit: true, via: 'memory', engram: recall.engram, stack_fp: stackFp, ms: 0, answer: recall.answer });
      say('    ' + t('ask.answer.memory', { engram: recall.engram ?? 'memory', date: new Date(recall.learned_at ?? 0).toISOString().slice(0, 10) }));
      return finish({ answer: recall.answer, via: 'memory', engram: recall.engram, shape: recall.shape, recall, bought: null, retrieved: null, bake: null, refusal: null, outcome: 'memory', success: true });
    }
  }

  // ---------------------------------------------------------------- [2] is there a knowledge on sale that covers it?
  let bought: AgentResult | null = null;
  if (o.buy !== false) {
    let pick: CatalogEntry | null = null;
    try {
      const catalog = await fetchCatalog(market);
      pick = pickPatch(catalog, o.question, undefined, undefined, { followLatest: true, followPrice: 'same-price', ...(o.maxPrice !== undefined ? { maxPrice: o.maxPrice } : {}) });
      // Quorum, sale state and price are `runAgent`'s own checks and it makes them again; this side only decides
      // whether there is anything worth reserving money for.
      if (pick && (pick.quorum_ok === false || pick.sellable === false)) pick = null;
    } catch (e) {
      say('[2] ' + t('ask.catalog.failed', { why: (e as Error).message }));
    }
    if (!pick) say('[2] ' + t('ask.buy.none', { market }));
    else {
      const price = String(pick.anchor.price ?? '0');
      const currency = pick.anchor.currency;
      say('[2] ' + t('ask.buy.found', { patch: pick.anchor.id, price, currency, passed: pick.passed, quorum: pick.quorum }));
      let hold;
      try {
        hold = budget.reserve({ kind: 'money', amount: price, act: 'buy', ref: pick.anchor.id, currency, market, ...(o.maxPrice !== undefined ? { max: String(o.maxPrice) } : {}) });
      } catch (e) {
        if (!(e instanceof BudgetRefusal)) throw e;
        say('    ' + e.message);
        return finish({ answer: null, via: null, engram: null, shape: recall.shape, recall, bought: null, retrieved: null, bake: null, refusal: { kind: e.kind, code: e.code, flag: e.flag, message: e.message }, outcome: 'refused', success: false });
      }
      try {
        // Unchanged: the whole purchase — 402, payment, manifest hash, body sha256 against the on-ledger anchor,
        // apply without restart. `noProbe` because what a shared model answers belongs to whoever else has
        // something loaded on it, and `keep` because accumulation is the point.
        bought = await runAgent({
          market, patch: pick.anchor.id, question: o.question, noProbe: true, keep: true, home,
          ...(api ? { api } : {}), ...(o.repo ? { repo: o.repo } : {}), ...(o.pay ? { pay: o.pay } : {}),
          ...(o.ainProvider ? { ainProvider: o.ainProvider } : {}), ...(o.privateKey ? { privateKey: o.privateKey } : {}),
          ...(o.maxPrice !== undefined ? { maxPrice: o.maxPrice } : {}), ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
          downloadOnly: !o.repo,
        }, (l) => say('    ' + l));
        /*
         * Settle what MOVED, not what was quoted.
         *
         * `runAgent` reports `owned: true` with the amount and tx hash of the EXISTING receipt when this agent
         * already holds the knowledge — no 402 is answered and no money leaves. Settling the price there would
         * spend today's budget on a purchase that did not happen, so asking the same uncovered question twice would
         * burn the day's allowance while paying nothing. `already_known` is the same: nothing was bought.
         */
        const paid = !bought.owned && bought.outcome !== 'already_known';
        if (paid) {
          cost.money = hold.settle(bought.amount ?? price, bought.tx_hash ?? undefined);
          cost.currency = currency;
        } else {
          hold.release(bought.owned ? `already owned: ${purchasesFile(home)} has a receipt for ${bought.patch_id ?? pick.anchor.id} and no money moved` : 'the model already answered it; nothing was bought');
        }
        // The `buy` event is written whether or not money moved this time: it is what makes the knowledge part of
        // this agent's memory, and the amount it carries is the receipt's, which is what was ever paid for it.
        memory.recordBuy({
          patch_id: bought.patch_id ?? pick.anchor.id, sha256: bought.sha256 ?? '', amount: bought.amount ?? price,
          currency, tx_hash: bought.tx_hash, seller: bought.seller ?? null, rows_learned: pick.anchor.benchmark.samples?.length ?? 0,
        });
        // An anchor carries at most TEACH_SAMPLES_ON_CHAIN benchmark samples: that is what a buyer can learn about a
        // knowledge without its training set, and it is what memory is seeded with.
        const samples = pick.anchor.benchmark.samples ?? [];
        if (samples.length) {
          memory.learnFromAnchor({ patch_id: bought.patch_id ?? pick.anchor.id, sha256: bought.sha256 ?? '', samples });
          say('    ' + t('ask.buy.learned', { rows: samples.length, patch: bought.patch_id ?? pick.anchor.id }));
        }
        if (boughtAndLoaded(bought)) {
          memory.recordApply({ patch_id: bought.patch_id ?? pick.anchor.id, sha256: bought.sha256 ?? '', position: null, stack_fp_after: null });
        }
      } catch (e) {
        hold.release(`the purchase failed: ${(e as Error).message}`);
        say('    ' + t('ask.buy.failed', { why: (e as Error).message }));
      }
      // Ask memory again: the anchor's samples may now answer the question outright.
      const after = memory.recall(o.question, { stackFp, hasModel });
      if (after.hit && after.answer && after.decision !== 'miss') {
        memory.recordRecall({ row_key: after.row_key, shape: after.shape, hit: true, via: 'memory', engram: after.engram, stack_fp: stackFp, ms: 0, answer: after.answer });
        return finish({ answer: after.answer, via: 'knowledge', engram: after.engram, shape: after.shape, recall: after, bought, retrieved: null, bake: null, refusal: null, outcome: 'knowledge', success: true });
      }
    }
  }

  // ---------------------------------------------------------------- [3] retrieve — the path that costs every time
  let retrieved: import('./retrieve.js').RetrieveResult | null = null;
  let plansLoaded = 0;
  if (o.retrieve !== false) {
    const R: RetrieveModule = await import('./retrieve.js');
    const P = await import('./plans.js');
    const loaded = P.loadPlans({ home });
    const usable = o.plans?.length ? loaded.plans.filter((p) => o.plans!.some((g) => p.id === g || p.id.startsWith(g))) : loaded.plans;
    plansLoaded = usable.length;
    for (const e of loaded.errors) say('    ' + t('ask.plan.unreadable', { file: e.file, why: e.error }));
    const chosen = R.planForQuestion(usable, o.question);
    if (!chosen.ok) {
      // A question outside every declared phrasing is NOT retrieved. The agent says what it has and stops, rather
      // than guessing a query with somebody else's API key.
      say('[3] ' + t('ask.plan.none', { plans: usable.map((p) => p.id).join(', ') || '—' }));
      for (const l of R.explainNoPlan(usable, chosen, locale)) say('    ' + l);
    } else {
      const { plan, slots } = chosen.candidate;
      // Announced BEFORE the call, not after it: the line says what is about to be spent, and a retrieval that
      // hangs or fails must still leave a record of which plan and which slots were about to be sent.
      say('[3] ' + t('ask.plan.matched', { plan: plan.id, shape: P.shortShape(P.shapeOf(P.bindPlan(plan, slots))), slots: JSON.stringify(slots) }));
      try {
        retrieved = await R.retrieve({
          plan, slots, home, locale, log: (l) => say('    ' + l),
          budget: {
            reserve: (kind, amount, forWhat) => {
              const hold = budget.reserve({ kind, amount, act: forWhat, ref: plan.id });
              return { settle: (actual?: number) => { hold.settle(actual); }, release: () => hold.release('the upstream call was not made') };
            },
          },
          memory: {
            row: (key) => { const r = memory.index.rows[key]; return r ? { answer: r.answer } : null; },
            append: (ev) => { memory.append(ev); },
          },
        });
      } catch (e) {
        if (e instanceof BudgetRefusal) {
          say('[3] ' + e.message);
          return finish({ answer: null, via: null, engram: null, shape: recall.shape, recall, bought, retrieved: null, bake: null, refusal: { kind: e.kind, code: e.code, flag: e.flag, message: e.message }, outcome: 'refused', success: false });
        }
        say('[3] ' + t('ask.retrieve.failed', { why: (e as Error).message }));
      }
    }
  }

  let answer: string | null = null;
  let shape: string | null = recall.shape;
  if (retrieved) {
    cost.queries += retrieved.queries;
    shape = retrieved.shape;
    // The row the question asked for is the one whose normalized prompt IS the question's key — never "the first
    // row", which would answer a question with somebody else's fact whenever the plan's filter did not bite.
    const mine = retrieved.rows.find((r) => rowKey(r.prompt) === base.row_key) ?? null;
    if (mine) {
      answer = mine.answer;
      memory.recordRecall({ row_key: base.row_key, shape, hit: true, via: 'memory', engram: null, stack_fp: stackFp, ms: retrieved.ms, answer });
      say('    ' + t('ask.answer.retrieval', { rows: retrieved.rows.length, server: retrieved.provenance.server.name }));
    } else if (retrieved.primary) {
      // The plan's query is filtered by the slots, so the row it produced IS the fact that was asked for — but the
      // wording differs from the question, so the row's own prompt travels with the answer and the mismatch shows.
      answer = retrieved.primary.answer;
      /*
       * And the question is remembered IN THE WORDING IT WAS ASKED, as an alias of the row that answered it.
       *
       * `retrieve.ts` learns each row under the PLAN's `mapping.prompt` — "What is the Ethereum mainnet contract
       * address of the USD Coin (USDC) token?" — which is not a sentence anybody types and is in none of the plan's
       * own match patterns. Without this line the next identical ask misses memory and pays for the lookup again,
       * for ever: measured on 2026-09-07, the second ask of "what is the contract address of USDC?" reported
       * `recall.decision: "miss"` and spent a second query on a fact already on disk. The link is evidence, not a
       * guess — the slots were bound out of this question and the upstream query carried them (see `learnAsked`).
       */
      memory.learnAsked({ question: o.question, answer, canonical: rowKey(retrieved.primary.prompt), shape });
      memory.recordRecall({ row_key: base.row_key, shape, hit: true, via: 'memory', engram: null, stack_fp: stackFp, ms: retrieved.ms, answer });
      say('    ' + t('ask.answer.paraphrase', { prompt: JSON.stringify(retrieved.primary.prompt) }));
      say('    ' + t('ask.answer.retrieval', { rows: retrieved.rows.length, server: retrieved.provenance.server.name }));
    }
  }

  // ---------------------------------------------------------------- [4] should this shape be compiled into memory?
  let bakeOut: AskResult['bake'] = null;
  if (o.bake !== false && shape) {
    const view = memory.view({ shape }).shapes.find((s) => s.shape === shape) ?? null;
    if (view) {
      const policy: BakePolicy = { bakeAfter: o.bakeAfter ?? null, maxChurn: o.maxChurn ?? 0 };
      const gpu = Number(o.gpuSecondsPerLesson ?? 0);
      const probe: BudgetProbe = (kind, amount) => {
        const v = budget.view(kind);
        if (amount <= 0) return { ok: true, line: '' };
        if (v.remaining === null) return { ok: false, line: `${v.unit}: no cap set — ${v.flag} would set one` };
        return { ok: Number(v.remaining) >= amount, line: `${v.unit}: ${amount} needed, ${v.remaining} of ${v.effective_cap} left today` };
      };
      const decision = shouldBake(view, policy, { home, budget: probe, gpuSeconds: gpu });
      say('[4] ' + t(decision.say.key, decision.say.vars));
      let result: BakeRun | null = null;
      if (decision.bake) {
        const B: BakeRunModule = await import('./bake.js');
        result = await B.runBake({
          shape: view.shape, market, home, memory, budget, locale,
          ...(o.gpuSecondsPerLesson !== undefined ? { gpuSecondsPerLesson: o.gpuSecondsPerLesson } : {}),
          ...(o.privateKey ? { privateKey: o.privateKey } : {}),
          log: (l) => say('    ' + l),
        });
        cost.lessons += result.lesson_spent ? 1 : 0;
        cost.gpu_s = result.gpu_seconds_settled;
      }
      bakeOut = { decision, result };
    }
  }

  if (answer) {
    return finish({ answer, via: 'retrieval', engram: null, shape, recall, bought, retrieved, bake: bakeOut, refusal: null, outcome: 'retrieval', success: true });
  }
  memory.recordRecall({ row_key: base.row_key, shape, hit: false, via: 'none', engram: null, stack_fp: stackFp, ms: 0 });
  say(t('ask.answer.none', { market }));
  return finish({ answer: null, via: null, engram: null, shape, recall, bought, retrieved, bake: bakeOut, refusal: null, outcome: 'unanswered', success: false });
}
