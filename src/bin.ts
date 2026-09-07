#!/usr/bin/env node
/**
 * `ainize-agent` (alias `ngram-agent`) — autonomous knowledge buyer for the Ainize marketplace: notices the model
 * does not know something, buys a verified knowledge patch with automatic payment (HTTP 402) and loads it.
 */
import './quiet.js';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import {
  agentBalance, exitCodeFor, fetchCatalog, pendingFile, purchasesFile, readPending, readPurchases, runAgent, spentToday, watchAgent,
  type AgentOptions, type WatchOptions,
} from './agent.js';
import { ask, type AskOptions } from './ask.js';
import { AgentBudget, BudgetRefusal, spendFile, type CapFlags } from './budget.js';
import { agentLocale, translator } from './i18n.js';
import { agentHome, loadIdentity } from './identity.js';
import { AgentMemory, fetchRuntime, runtimeLine } from './memory.js';
import { loadPlans, planSelfCheck, planShape, shortShape } from './plans.js';
import { LOOP_STRINGS } from './strings/loop.js';

/**
 * The built-in demo (item 233). These used to be the DEFAULTS of `--question`, `--prompt` and `--expect`, so
 * `run --patch krx-all-2761` measured a knowledge of 2,761 tickers against one fact from a different one and
 * reported FAILED — or bought nothing at all, because the shared model already answered the demo question. They
 * are used only when the caller named nothing to buy and nothing to ask, and the run says so.
 */
const DEMO = { question: '픽셀플러스 종목코드 알려줘', prompt: '종목코드 픽셀플러스 ', expect: '087600' };

/**
 * The currency this market prices in, from the public `GET /api/info`. `null` when the node will not say, which is
 * not a reason to guess one: the caller then falls back to the budget module's own default and the report says which
 * currency it measured.
 */
async function marketCurrency(market: string): Promise<string | null> {
  try {
    const r = await fetch(`${market.replace(/\/+$/, '')}/api/info`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { currency?: unknown };
    return typeof j.currency === 'string' && j.currency ? j.currency : null;
  } catch { return null; }
}

/** `a,b` or repeated flags → a clean list. */
const list = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

// Two bins point here: `ainize-agent` (product name, Ainize = AI + -ize) and the historical `ngram-agent`.
const PROG_NAMES = ['ainize-agent', 'ngram-agent'];
const argv1 = basename(process.argv[1] ?? '').replace(/\.(c|m)?js$/, '');
const PROG = PROG_NAMES.includes(argv1) ? argv1 : 'ainize-agent';

const cli = yargs(hideBin(process.argv))
  .scriptName(PROG)
  .usage([
    '$0 <command> [options]', '',
    'Ainize agent — an AI agent that ainizes its own knowledge gap: it detects a missing fact on the',
    'serving model, buys a verified knowledge patch from an Ainize node with automatic payment',
    '(HTTP 402 / x402) and loads it into the running model.',
  ].join('\n'))
  .option('market', { type: 'string', describe: 'marketplace node URL', default: process.env.NGRAM_MARKET ?? 'http://localhost:3402', global: true })
  .option('home', { type: 'string', describe: 'agent home (identity, downloads)', default: undefined, global: true })
  .option('json', { type: 'boolean', default: false, global: true })
  .alias('h', 'help').help().version().strict().wrap(Math.min(110, process.stdout.columns || 100))
  .demandCommand(1, `Specify a command. Try \`${PROG} --help\`.`);

cli.command('run', 'Detect → discover → pay (402) → download → verify → apply', (y) => y
  .option('question', { type: 'string', describe: 'natural question (used to search the catalog); with --patch it defaults to that knowledge\'s own benchmark' })
  .option('expect', { type: 'string', describe: 'expected answer prefix; with --patch it defaults to the knowledge\'s first benchmark sample' })
  .option('max-price', { type: 'number', describe: 'refuse to pay more than this amount (seller currency), the bases it needs included' })
  .option('follow-latest', { type: 'boolean', default: true, describe: 'switch to the newest version when the requested one is superseded (--no-follow-latest buys exactly what was named)' })
  .option('follow-price', { choices: ['same-price', 'any'] as const, default: 'same-price', describe: 'how much a newer version may cost: no more than the item asked for, or anything (still under --max-price)' })
  .option('track', { type: 'string', describe: 'buy the newest verified knowledge of this track instead of naming an id (e.g. daily/krx)' })
  .option('repay', { type: 'boolean', default: false, describe: 'buy again something this agent already has a receipt for (purchases.jsonl)' })
  .option('download-only', { type: 'boolean', default: false, describe: 'the run is done when the body is on disk — do not report "not loaded" as a failure' })
  .option('prompt', { type: 'string', describe: 'raw completion prompt for the model' })
  // Item 230: no default here. The serving API is READ FROM THE MARKET NODE (`GET /api/runtime`) unless one is
  // named, so the before/after is measured on the model the knowledge was actually loaded into.
  .option('api', { type: 'string', describe: 'serving API (OpenAI-compatible); default: whatever the market node reports at /api/runtime' })
  .option('patch', { type: 'string', describe: 'patch id to buy (skip search)' })
  // …and no default repo either: writing into a shared model that belongs to a node is opt-in, under that node's lock.
  .option('repo', { type: 'string', describe: 'load the knowledge directly into this runtime repo (takes the node\'s runtime lock); omitted = do not touch the model' })
  .option('restore', { type: 'boolean', default: false, describe: 'unload the knowledge again after the check (default: leave it loaded — removing it writes the model\'s own rows back over whatever else is loaded)' })
  .option('pay', { choices: ['auto', 'local-credit', 'ain-transfer'] as const, default: 'auto' })
  .option('ain-provider', { type: 'string', default: process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081' })
  .option('private-key', { type: 'string', describe: 'use this key instead of the stored identity' })
  .option('max-tokens', { type: 'number', default: 8 })
  .example('$0 run --market http://localhost:3402', 'the built-in KRX demo (Pixelplus 087600)')
  .example('$0 run --patch krx-all-2761', 'buy one knowledge and measure it against its own benchmark')
  .example('$0 run --track daily/krx --max-price 5', 'buy the newest verified bake of a track, under a budget'),
async (a) => {
  // Item 233: the demo fills in only when nothing at all was named — and it is announced in the run.
  const demo = !a.question && !a.prompt && !a.patch && !a.track;
  const opts: AgentOptions = {
    market: a.market, question: a.question ?? (demo ? DEMO.question : undefined), expect: a.expect ?? (demo ? DEMO.expect : undefined),
    prompt: a.prompt ?? (demo ? DEMO.prompt : undefined), demo,
    api: a.api, patch: a.patch, track: a.track, repo: a.repo, keep: !a.restore, home: a.home, pay: a.pay as AgentOptions['pay'],
    ainProvider: a['ain-provider'], privateKey: a['private-key'], maxTokens: a['max-tokens'], maxPrice: a['max-price'],
    followLatest: a['follow-latest'], followPrice: a['follow-price'] as AgentOptions['followPrice'],
    repay: a.repay, downloadOnly: a['download-only'],
  };
  const steps: string[] = [];
  try {
    const res = await runAgent(opts, (l) => { steps.push(l); if (!a.json) process.stdout.write(l + '\n'); });
    if (a.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    // Item 284: exit 0 only when the knowledge is LOADED (or a download was all that was asked for). A run that
    // ended with the body on disk and nothing in any model exits 3, so automation cannot mistake it for live.
    const code = exitCodeFor(res, !!a['download-only']);
    if (code === 3 && !a.json) process.stderr.write(chalk.yellow('! ') + `downloaded, NOT loaded: ${res.path ?? 'the body'} is on this machine and no model has it. Load it with \`ainize patch apply ${res.patch_id}\` on the serving node, or pass --repo / --download-only.\n`);
    process.exit(code);
  } catch (e) {
    // Item 274: a failure after the money moved is still a result. With --json the partial result is printed —
    // including the tx hash and where the pending payment was written — instead of a bare "agent failed" line.
    const msg = (e as Error).message;
    if (a.json) {
      const pending = readPending(agentHome(a.home));
      process.stdout.write(JSON.stringify({
        success: false, error: msg, steps,
        identity: loadIdentity(agentHome(a.home)).address,
        pending_payments: pending, tx_hash: pending[pending.length - 1]?.tx_hash ?? null,
        pending_file: pendingFile(agentHome(a.home)),
      }, null, 2) + '\n');
    }
    process.stderr.write(chalk.red('agent failed: ') + msg + '\n');
    process.exit(1);
  }
});

/**
 * Item 232 — `catalog` listed LISTED only, so the cheaper, superseded item the market still sells was invisible:
 * the developer could not see the choice the agent was making on their behalf between a 0.1 and a 25 knowledge.
 */
cli.command('catalog', 'List the knowledge on sale (LISTED and the older versions still sold beside them)', (y) => y
  .option('status', { type: 'string', default: 'LISTED,SUPERSEDED', describe: 'comma list of statuses to show' }), async (a) => {
  const items = await fetchCatalog(a.market, a.status);
  if (a.json) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return; }
  for (const e of items) {
    const status = e.status === 'LISTED' ? chalk.green(e.status.padEnd(10)) : chalk.gray(e.status.padEnd(10));
    const newer = e.superseded_by.length ? chalk.gray(`  newer: ${e.superseded_by.join(', ')}`) : '';
    /**
     * Item 282 — an agent never opens a page, so this line was the only place it could learn that the 3-credit row
     * it is about to prefer over a 5-credit one is an ADD-ON: useless on its own, and only priced that way because
     * the base is bought separately. `base.stack` is the body that needs those tables underneath it; `parents` is a
     * knowledge that stands alone and shares revenue upward.
     */
    const stack = (e.anchor.base?.stack ?? []).map((b) => b.patch_id);
    const parents = e.anchor.parents ?? [];
    const built = stack.length ? chalk.yellow(`  add-on, needs: ${stack.join(', ')}`)
      : parents.length ? chalk.gray(`  built on: ${parents.join(', ')}`) : '';
    process.stdout.write(`${chalk.cyan(e.anchor.id.padEnd(24))} ${status} ${String(e.anchor.rows).padStart(8)} rows  ${e.anchor.price} ${e.anchor.currency}  attest ${e.passed}/${e.quorum}  ${e.anchor.name}${built}${newer}\n`);
  }
  if (!items.length) process.stdout.write(chalk.gray('(no patches)\n'));
});

/**
 * Item 285 — this printed "100 CREDIT (initial credit 100 …)" against a node whose ledger is `ain` and whose wallet
 * held 196.5 AIN: a derived local-credit figure, presented with confidence, for a market that does not use it. The
 * ledger the node actually runs decides which number this is, and the funding hint is only the local dev command
 * when the chain really is local.
 */
cli.command('balance', 'What this agent can spend on a market (AIN from the chain, or the node\'s local dev credit)', (y) => y
  .option('initial', { type: 'number', describe: 'override the initial local credit instead of reading /api/info.initial_credit' })
  .option('ain-provider', { type: 'string', default: process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081' }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  try {
    const b = await agentBalance(a.market, id, { ainProvider: a['ain-provider'], initialCredit: a.initial });
    if (a.json) { process.stdout.write(JSON.stringify(b) + '\n'); return; }
    process.stdout.write(`${b.address}  ${b.balance === null ? chalk.yellow('unknown (the chain did not answer)') : `${b.balance} ${b.currency}`} ${chalk.gray(`(${b.note})`)}\n`);
    process.stdout.write(chalk.gray(`  more: ${b.fund}\n`));
    const spent = spentToday(agentHome(a.home));
    if (Object.keys(spent).length) process.stdout.write(chalk.gray(`  spent today: ${Object.entries(spent).map(([k, v]) => `${v} ${k}`).join(', ')} (${purchasesFile(agentHome(a.home))})\n`));
  } catch (e) {
    process.stderr.write(chalk.red('balance failed: ') + (e as Error).message + '\n');
    process.exit(1);
  }
});

/**
 * Item 286 — an agent's purchases left no receipt it could read back: no file, no `purchases` command, and no
 * buyer filter on any ledger, so "what do I already own?" could only be answered by scraping every seller.
 */
cli.command('purchases', 'What this agent has bought: what, from whom, for how much, and where the file is', (y) => y, async (a) => {
  const home = agentHome(a.home);
  const rows = readPurchases(home);
  if (a.json) { process.stdout.write(JSON.stringify({ home, file: purchasesFile(home), items: rows, spent_today: spentToday(home) }, null, 2) + '\n'); return; }
  if (!rows.length) {
    process.stdout.write(chalk.gray(`nothing bought yet — the receipts would be in ${purchasesFile(home)}\n`));
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${new Date(r.at).toISOString().slice(0, 19).replace('T', ' ')}  ${chalk.cyan(r.patch_id.padEnd(24))} ${String(r.amount).padStart(8)} ${r.asset.padEnd(7)} → ${r.seller_name ?? r.seller}  tx ${r.tx_hash.slice(0, 14)}…\n`);
    process.stdout.write(chalk.gray(`  ${r.path}${existsSync(r.path) ? '' : '  (file no longer here)'}\n`));
  }
  const spent = spentToday(home);
  process.stdout.write(chalk.gray(`${rows.length} purchase(s) · spent today ${Object.entries(spent).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}\n`));
});

/**
 * Item 287 — "keep these knowledges loaded and current" had to be written by every user: the agent was one-shot,
 * a naive cron of `agent run` was a repeat-purchase loop, and nothing tracked ownership, versions or a budget.
 */
cli.command('watch', 'Keep knowledge (or a track) current: buy what is new, follow newer versions under a budget, never re-buy', (y) => y
  .option('patch', { type: 'string', array: true, describe: 'knowledge id(s) to keep current (comma-separated or repeated)' })
  .option('track', { type: 'string', array: true, describe: 'track name(s) whose newest verified knowledge to keep' })
  .option('budget-per-day', { type: 'number', describe: 'the most this agent may spend in a day (read back from purchases.jsonl)' })
  .option('interval', { type: 'number', default: 300, describe: 'seconds between cycles' })
  .option('once', { type: 'boolean', default: false, describe: 'run one cycle and exit (for cron)' })
  .option('max-price', { type: 'number', describe: 'refuse any single purchase above this' })
  .option('follow-latest', { type: 'boolean', default: true })
  .option('follow-price', { choices: ['same-price', 'any'] as const, default: 'same-price' })
  .option('repo', { type: 'string', describe: 'also load what it buys into this runtime repo (takes the node\'s lock); omitted = buy only' })
  .option('api', { type: 'string', describe: 'serving API; default: whatever the market node reports at /api/runtime' })
  .option('pay', { choices: ['auto', 'local-credit', 'ain-transfer'] as const, default: 'auto' })
  .option('ain-provider', { type: 'string', default: process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081' })
  .option('private-key', { type: 'string', describe: 'use this key instead of the stored identity' })
  .example('$0 watch --track daily/krx --budget-per-day 30 --once', 'one cron cycle: buy today\'s bake if it is new and affordable'),
async (a) => {
  const opts: WatchOptions = {
    market: a.market, patches: list(a.patch), tracks: list(a.track), budgetPerDay: a['budget-per-day'],
    intervalS: a.interval, once: a.once, home: a.home, repo: a.repo, api: a.api, maxPrice: a['max-price'],
    followLatest: a['follow-latest'], followPrice: a['follow-price'] as WatchOptions['followPrice'],
    pay: a.pay as WatchOptions['pay'], ainProvider: a['ain-provider'], privateKey: a['private-key'],
  };
  const lines: string[] = [];
  let stop = false;
  process.on('SIGINT', () => { stop = true; process.stderr.write(chalk.gray('\nstopping after this cycle…\n')); });
  try {
    const cycles = await watchAgent(opts, (l) => { lines.push(l); if (!a.json) process.stdout.write(l + '\n'); }, () => stop);
    if (a.json) process.stdout.write(JSON.stringify({ cycles }, null, 2) + '\n');
    const failed = cycles[cycles.length - 1]?.actions.some((x) => x.action === 'failed');
    process.exit(failed ? 1 : 0);
  } catch (e) {
    if (a.json) process.stdout.write(JSON.stringify({ error: (e as Error).message, lines }, null, 2) + '\n');
    process.stderr.write(chalk.red('watch failed: ') + (e as Error).message + '\n');
    process.exit(1);
  }
});

/**
 * `ask` — the loop, and the reason this package exists.
 *
 *   recall (0 completions to decide) → buy a knowledge that covers it → retrieve it from upstream → ainize it.
 *
 * `run` is unchanged and still means "buy this knowledge and measure it against its benchmark". `ask` means "answer
 * this question as cheaply as you honestly can, and remember what you learn".
 */
cli.command('ask <question>', 'Answer a question from memory, or buy / retrieve it — and compile it when repeating costs more than compiling', (y) => y
  .positional('question', { type: 'string', demandOption: true, describe: 'the question, as a person would ask it' })
  .option('plan', { type: 'string', array: true, describe: 'restrict retrieval to these plan ids (comma-separated or repeated)' })
  .option('bake-after', { type: 'number', describe: 'DECLARED policy: compile a shape on its nth lookup. Not a measurement, and labelled as one wherever it appears' })
  .option('max-churn', { type: 'number', default: 0, describe: 'how much of a shape may have moved between two pulls and still be compiled (0 = none)' })
  .option('budget-per-day', { type: 'string', describe: 'the most this agent may spend in a day, in the market\'s currency' })
  .option('queries-per-day', { type: 'string', describe: 'the most upstream MCP calls it may make in a day' })
  .option('lessons-per-day', { type: 'string', describe: 'the most teach jobs it may spend in a day (the node\'s own limit still applies, and the tighter wins)' })
  .option('gpu-seconds-per-day', { type: 'string', describe: 'the most GPU seconds it may reserve in a day' })
  .option('gpu-seconds-per-lesson', { type: 'string', describe: 'the trainer\'s worst case for one lesson; the node does not publish it, so without this a bake refuses rather than holding a number nobody measured' })
  .option('max-price', { type: 'number', describe: 'refuse any single purchase above this' })
  .option('api', { type: 'string', describe: 'serving API; default: whatever the market node reports at /api/runtime' })
  .option('repo', { type: 'string', describe: 'load what it buys into this runtime repo (takes the node\'s lock); omitted = do not touch the model' })
  // Declared positively so yargs' own negation gives `--no-buy` / `--no-retrieve` / `--no-bake`, the same way
  // `run --no-follow-latest` already works. Each turns ONE step off without turning the loop off.
  .option('buy', { type: 'boolean', default: true, describe: '--no-buy: never buy — answer from memory or retrieval only' })
  .option('retrieve', { type: 'boolean', default: true, describe: '--no-retrieve: never call an upstream server' })
  .option('bake', { type: 'boolean', default: true, describe: '--no-bake: never spend a lesson, however often the shape repeats' })
  .option('max-tokens', { type: 'number', default: 16 })
  .option('pay', { choices: ['auto', 'local-credit', 'ain-transfer'] as const, default: 'auto' })
  .option('ain-provider', { type: 'string', default: process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081' })
  .option('private-key', { type: 'string', describe: 'use this key instead of the stored identity' })
  .example('$0 ask "what is the contract address of USDC?"', 'answer it the cheapest honest way, and remember it')
  .example('$0 ask "…" --bake-after 3 --lessons-per-day 1 --queries-per-day 20', 'close the loop in one session: the 3rd lookup of a shape compiles it'),
async (a) => {
  const caps: CapFlags = {
    ...(a['budget-per-day'] !== undefined ? { money: a['budget-per-day'] } : {}),
    ...(a['queries-per-day'] !== undefined ? { queries: a['queries-per-day'] } : {}),
    ...(a['lessons-per-day'] !== undefined ? { lessons: a['lessons-per-day'] } : {}),
    ...(a['gpu-seconds-per-day'] !== undefined ? { gpu_s: a['gpu-seconds-per-day'] } : {}),
  };
  const opts: AskOptions = {
    question: String(a.question), market: a.market, home: a.home, caps,
    buy: a.buy, retrieve: a.retrieve, bake: a.bake,
    maxChurn: a['max-churn'], maxTokens: a['max-tokens'], pay: a.pay as AskOptions['pay'],
    ainProvider: a['ain-provider'],
    ...(a.plan?.length ? { plans: list(a.plan) } : {}),
    ...(a['bake-after'] !== undefined ? { bakeAfter: a['bake-after'] } : {}),
    ...(a['max-price'] !== undefined ? { maxPrice: a['max-price'] } : {}),
    ...(a.api ? { api: a.api } : {}),
    ...(a.repo ? { repo: a.repo } : {}),
    ...(a['gpu-seconds-per-lesson'] !== undefined ? { gpuSecondsPerLesson: a['gpu-seconds-per-lesson'] } : {}),
    ...(a['private-key'] ? { privateKey: a['private-key'] } : {}),
  };
  try {
    const res = await ask(opts, (l) => { if (!a.json) process.stdout.write(l + '\n'); });
    if (a.json) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); }
    else if (res.answer) process.stdout.write('\n' + chalk.green(res.answer) + chalk.gray(`  (via ${res.via})\n`));
    // 0 answered · 1 no answer · 2 a budget refused and nothing was spent. A refusal is not a crash: an unattended
    // loop has to be able to tell "I could not afford this" from "I broke".
    process.exit(res.outcome === 'refused' ? 2 : res.answer ? 0 : 1);
  } catch (e) {
    if (e instanceof BudgetRefusal) {
      if (a.json) process.stdout.write(JSON.stringify({ refused: { kind: e.kind, code: e.code, flag: e.flag, message: e.message, details: e.details } }, null, 2) + '\n');
      process.stderr.write(chalk.yellow('refused: ') + e.message + '\n');
      process.exit(2);
    }
    if (a.json) process.stdout.write(JSON.stringify({ error: (e as Error).message }, null, 2) + '\n');
    process.stderr.write(chalk.red('ask failed: ') + (e as Error).message + '\n');
    process.exit(1);
  }
});

/** What this agent knows, what it owns, what it has looked up, and what it would take to compile any of it. */
cli.command('memory', 'What this agent remembers: facts, knowledge, shapes and the disagreements it recorded', (y) => y
  .option('shape', { type: 'string', describe: 'one shape (or a prefix of one, or a plan id)' })
  .option('why', { type: 'string', describe: 'why that shape has (not) been compiled — every gate, with its numbers' })
  .option('rows', { type: 'number', default: 20, describe: 'how many facts to list' })
  .option('bake-after', { type: 'number', describe: 'evaluate --why against this declared floor as well' })
  .option('max-churn', { type: 'number', default: 0 })
  .option('runtime', { type: 'boolean', default: true, describe: 'also ask the market node what is on the model (--no-runtime keeps it offline)' }),
async (a) => {
  const home = agentHome(a.home);
  const mem = AgentMemory.open(home);
  const runtime = a.runtime ? await fetchRuntime(a.market) : null;
  /*
   * Reconcile BEFORE reporting, exactly as `ask` does, or this command prints a residency the node contradicts.
   *
   * Measured on 2026-09-07: with the node's `applied` table emptied under it, `memory` went on reporting
   * "on the model 1" and `loaded` — and with the node listing a DIFFERENT sha256 for the same knowledge, it reported
   * `loaded` with no rule-3 conflict at all. The report already asked the node what was on the model; it just never
   * compared the two. `--no-runtime` still keeps it offline, and then it says so instead of guessing.
   */
  const reconcile = runtime ? mem.reconcile(runtime, { purchases: readPurchases(home).map((p) => ({ patch_id: p.patch_id, sha256: p.sha256, at: p.at })) }) : null;
  if (reconcile) mem.flush();
  const shapeArg = a.why ?? a.shape;
  const view = mem.view({ ...(shapeArg ? { shape: shapeArg } : {}), rows: a.rows });
  let why: unknown = null;
  if (a.why) {
    const { shouldBake } = await import('./bake.js');
    const s = view.shapes[0];
    if (!s) { process.stderr.write(chalk.yellow(`no shape matches ${a.why} — \`${PROG} memory\` lists the ones this home has\n`)); process.exit(1); }
    const budget = AgentBudget.open({ home });
    why = shouldBake(s, { bakeAfter: a['bake-after'] ?? null, maxChurn: a['max-churn'] }, {
      home,
      budget: (kind, amount) => {
        const v = budget.view(kind);
        if (amount <= 0) return { ok: true, line: '' };
        if (v.remaining === null) return { ok: false, line: `${v.unit}: no cap set — ${v.flag} would set one` };
        return { ok: Number(v.remaining) >= amount, line: `${v.unit}: ${amount} needed, ${v.remaining} of ${v.effective_cap} left today` };
      },
    });
  }
  if (a.json) { process.stdout.write(JSON.stringify({ ...view, runtime, reconcile, why }, null, 2) + '\n'); return; }
  process.stdout.write(view.summary + '\n');
  if (runtime) process.stdout.write(chalk.gray(runtimeLine(runtime) + '\n'));
  for (const line of reconcile?.lines ?? []) process.stdout.write(chalk.yellow('  ' + line + '\n'));
  for (const g of view.engrams) {
    const state = g.state === 'loaded' ? chalk.green('loaded  ') : g.state === 'held' ? chalk.yellow('held    ') : chalk.red('unverif.');
    process.stdout.write(`  ${state} ${chalk.cyan(g.patch_id.padEnd(24))} ${String(g.rows).padStart(6)} facts  ${g.source}${g.owned ? '' : chalk.gray('  (not this agent\'s)')}\n`);
  }
  for (const s of view.shapes) process.stdout.write('  ' + s.line + '\n');
  for (const c of view.conflicts) process.stdout.write(chalk.yellow(`  ! rule ${c.rule} ${c.what}: agent says ${c.agent_says}; node says ${c.node_says}\n`));
  if (why) {
    const d = why as { bake: boolean; gates: { name: string; ok: boolean; detail: Record<string, unknown> }[]; nstar: { n_star: number | null; missing: string[]; terms: { kind: string; why: string; n_star: number | null }[] } };
    process.stdout.write('\n' + chalk.bold(`would it be compiled? ${d.bake ? 'YES' : 'no'}\n`));
    for (const g of d.gates) process.stdout.write(`  ${g.ok ? chalk.green('ok  ') : chalk.red('no  ')}${g.name.padEnd(10)} ${JSON.stringify(g.detail)}\n`);
    for (const term of d.nstar.terms) process.stdout.write(chalk.gray(`  N* in ${term.kind}: ${term.n_star ?? 'not computable'} — ${term.why}\n`));
    for (const m of d.nstar.missing) process.stdout.write(chalk.yellow(`  missing: ${m}\n`));
  }
  for (const r of view.rows) process.stdout.write(chalk.gray(`  ${r.state === 'known' ? ' ' : '?'} ${r.row_key.slice(0, 60)} → ${r.answer.slice(0, 40)}\n`));
});

/** The four caps, what is left of each, and where each cap came from. Every number is read off a file on disk. */
cli.command('budget', 'What this agent may spend today, what it has spent, and which flag would change it', (y) => y
  .option('budget-per-day', { type: 'string' }).option('queries-per-day', { type: 'string' })
  .option('lessons-per-day', { type: 'string' }).option('gpu-seconds-per-day', { type: 'string' })
  .option('currency', { type: 'string', describe: 'the currency the money cap is read in (default: the market\'s)' }),
async (a) => {
  const home = agentHome(a.home);
  const caps: CapFlags = {
    ...(a['budget-per-day'] !== undefined ? { money: a['budget-per-day'] } : {}),
    ...(a['queries-per-day'] !== undefined ? { queries: a['queries-per-day'] } : {}),
    ...(a['lessons-per-day'] !== undefined ? { lessons: a['lessons-per-day'] } : {}),
    ...(a['gpu-seconds-per-day'] !== undefined ? { gpu_s: a['gpu-seconds-per-day'] } : {}),
  };
  /*
   * "default: the market's" was documented on --currency and implemented nowhere, so on a CREDIT market this report
   * measured against AIN and answered "0 spent" for a day the agent had paid 0.5 CREDIT. The node publishes it on
   * the public `GET /api/info`; a node that will not answer leaves the module default, and the extra line under
   * "money" names anything paid today in a currency this cap does not measure either way.
   */
  const currency = a.currency ?? await marketCurrency(a.market);
  const budget = AgentBudget.open({ home, flags: caps, ...(currency ? { currency } : {}) });
  if (a.json) { process.stdout.write(JSON.stringify({ home, spend_file: spendFile(home), views: budget.views() }, null, 2) + '\n'); return; }
  process.stdout.write(translator(LOOP_STRINGS, agentLocale())('view.budget.header', { home }) + '\n');
  for (const line of budget.lines()) process.stdout.write('  ' + line + '\n');
  process.stdout.write(chalk.gray(`  every number above is read from ${spendFile(home)} and ${purchasesFile(home)}\n`));
});

/** The declared phrasings this agent can retrieve — and, with --check, whether each plan is sane before it costs a query. */
cli.command('plans', 'The retrieval plans this agent has: what each asks, and what wording it answers to', (y) => y
  .option('check', { type: 'boolean', default: false, describe: 'validate every plan (does binding a slot change the shape? is a slot captured and never used?)' }),
async (a) => {
  const home = agentHome(a.home);
  const loaded = loadPlans({ home });
  const t = translator(LOOP_STRINGS, agentLocale());
  const checks = a.check ? Object.fromEntries(loaded.plans.map((p) => [p.id, planSelfCheck(p)])) : {};
  if (a.json) { process.stdout.write(JSON.stringify({ dirs: loaded.dirs, errors: loaded.errors, plans: loaded.plans.map((p) => ({ ...p, shape: planShape(p) })), checks }, null, 2) + '\n'); return; }
  process.stdout.write(t('view.plans.header', { dir: loaded.dirs.join(', ') }) + '\n');
  if (!loaded.plans.length) process.stdout.write(chalk.gray(t('view.plans.none', { dir: loaded.dirs.join(', ') }) + '\n'));
  for (const p of loaded.plans) {
    process.stdout.write(`${chalk.cyan(p.id.padEnd(30))} ${chalk.gray(shortShape(planShape(p)))}  ${p.server.name} · ${p.tool}\n`);
    if (p.description) process.stdout.write(chalk.gray(`  ${p.description}\n`));
    for (const pat of p.match.patterns) process.stdout.write(chalk.gray(`    "${pat}"\n`));
    for (const f of checks[p.id] ?? []) process.stdout.write(chalk.yellow(`    ! ${f}\n`));
  }
  for (const e of loaded.errors) process.stdout.write(chalk.red(`  ${e.file}: ${e.error}\n`));
  const bad = Object.values(checks).some((f) => f.length);
  process.exit(loaded.errors.length || bad ? 1 : 0);
});

cli.command('keys', 'Show (or create) the agent identity', (y) => y.option('reveal', { type: 'boolean', default: false }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  const out: Record<string, string> = { address: id.address, publicKey: id.publicKey, home: agentHome(a.home) };
  if (a.reveal) out.privateKey = id.privateKey;
  if (a.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else for (const [k, v] of Object.entries(out)) process.stdout.write(`${k.padEnd(11)} ${v}\n`);
});

await cli.parseAsync();
