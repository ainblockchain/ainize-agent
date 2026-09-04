#!/usr/bin/env node
/**
 * `ainize-agent` (alias `ngram-agent`) — autonomous knowledge buyer for the Ainize marketplace: notices the model
 * does not know something, buys a verified knowledge patch with automatic payment (HTTP 402) and loads it.
 */
import './quiet.js';
import { basename } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { creditBalance, fetchCatalog, fetchInitialCredit, pendingFile, readPending, runAgent, type AgentOptions } from './agent.js';
import { agentHome, loadIdentity } from './identity.js';

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
  .option('question', { type: 'string', default: '픽셀플러스 종목코드 알려줘', describe: 'natural question (used to search the catalog)' })
  .option('expect', { type: 'string', default: '087600', describe: 'expected answer prefix' })
  .option('max-price', { type: 'number', describe: 'refuse to pay more than this amount (seller currency)' })
  .option('follow-latest', { type: 'boolean', default: false, describe: 'with --patch: switch to the newest version when the requested one is superseded' })
  .option('prompt', { type: 'string', default: '종목코드 픽셀플러스 ', describe: 'raw completion prompt for the model' })
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
  .example('$0 run --market http://localhost:3402', 'default KRX demo (Pixelplus 087600)')
  .example('$0 run --patch krx-all-2761 --question "Samsung Electronics ticker code" --prompt "종목코드 삼성전자 " --expect 005930', 'buy a specific knowledge'),
async (a) => {
  const opts: AgentOptions = { market: a.market, question: a.question, expect: a.expect, prompt: a.prompt, api: a.api, patch: a.patch, repo: a.repo, keep: !a.restore, home: a.home, pay: a.pay as AgentOptions['pay'], ainProvider: a['ain-provider'], privateKey: a['private-key'], maxTokens: a['max-tokens'], maxPrice: a['max-price'], followLatest: a['follow-latest'] };
  const steps: string[] = [];
  try {
    const res = await runAgent(opts, (l) => { steps.push(l); if (!a.json) process.stdout.write(l + '\n'); });
    if (a.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.success ? 0 : 1);
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

cli.command('catalog', 'List LISTED patches on the market', (y) => y.option('status', { type: 'string', default: 'LISTED' }), async (a) => {
  const items = await fetchCatalog(a.market, a.status);
  if (a.json) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return; }
  for (const e of items) process.stdout.write(`${chalk.cyan(e.anchor.id.padEnd(24))} ${e.status.padEnd(10)} ${String(e.anchor.rows).padStart(8)} rows  ${e.anchor.price} ${e.anchor.currency}  attest ${e.passed}/${e.quorum}  ${e.anchor.name}\n`);
  if (!items.length) process.stdout.write(chalk.gray('(no patches)\n'));
});

cli.command('balance', 'Show this agent\'s local-credit balance on a market (initial credit read from the node\'s /api/info)', (y) => y
  .option('initial', { type: 'number', describe: 'override the initial credit instead of reading /api/info.initial_credit' }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  try {
    const initial = a.initial ?? await fetchInitialCredit(a.market);
    const bal = await creditBalance(a.market, id.address, initial);
    const src = a.initial !== undefined ? 'override' : `${a.market}/api/info`;
    if (a.json) process.stdout.write(JSON.stringify({ address: id.address, balance: bal, currency: 'CREDIT', initial_credit: initial, initial_credit_source: src }) + '\n');
    else process.stdout.write(`${id.address}  ${bal} CREDIT ${chalk.gray(`(initial credit ${initial} from ${src}; CREDIT = local dev credit of this node, not AIN)`)}\n`);
  } catch (e) {
    process.stderr.write(chalk.red('balance failed: ') + (e as Error).message + '\n');
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
