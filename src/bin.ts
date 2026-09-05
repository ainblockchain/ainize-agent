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
import { agentHome, loadIdentity } from './identity.js';

/**
 * The built-in demo (item 233). These used to be the DEFAULTS of `--question`, `--prompt` and `--expect`, so
 * `run --patch krx-all-2761` measured a knowledge of 2,761 tickers against one fact from a different one and
 * reported FAILED — or bought nothing at all, because the shared model already answered the demo question. They
 * are used only when the caller named nothing to buy and nothing to ask, and the run says so.
 */
const DEMO = { question: '픽셀플러스 종목코드 알려줘', prompt: '종목코드 픽셀플러스 ', expect: '087600' };

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
    process.stdout.write(`${chalk.cyan(e.anchor.id.padEnd(24))} ${status} ${String(e.anchor.rows).padStart(8)} rows  ${e.anchor.price} ${e.anchor.currency}  attest ${e.passed}/${e.quorum}  ${e.anchor.name}${newer}\n`);
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

cli.command('keys', 'Show (or create) the agent identity', (y) => y.option('reveal', { type: 'boolean', default: false }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  const out: Record<string, string> = { address: id.address, publicKey: id.publicKey, home: agentHome(a.home) };
  if (a.reveal) out.privateKey = id.privateKey;
  if (a.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else for (const [k, v] of Object.entries(out)) process.stdout.write(`${k.padEnd(11)} ${v}\n`);
});

await cli.parseAsync();
