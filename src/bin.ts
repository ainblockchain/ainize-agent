#!/usr/bin/env node
/** `ngram-agent` — autonomous knowledge buyer (x402) for the marketplace. */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { creditBalance, fetchCatalog, runAgent, type AgentOptions } from './agent.js';
import { agentHome, loadIdentity } from './identity.js';

const cli = yargs(hideBin(process.argv))
  .scriptName('ngram-agent')
  .usage('$0 <command> [options]\n\nAn agent that detects missing knowledge, buys a verified patch over HTTP 402 and applies it.')
  .option('market', { type: 'string', describe: 'marketplace node URL', default: process.env.NGRAM_MARKET ?? 'http://localhost:3402', global: true })
  .option('home', { type: 'string', describe: 'agent home (identity, downloads)', default: undefined, global: true })
  .option('json', { type: 'boolean', default: false, global: true })
  .alias('h', 'help').help().version().strict().wrap(Math.min(110, process.stdout.columns || 100))
  .demandCommand(1, 'Specify a command. Try `ngram-agent --help`.');

cli.command('run', 'Detect → discover → pay (402) → download → verify → apply', (y) => y
  .option('question', { type: 'string', default: '픽셀플러스 종목코드 알려줘', describe: 'natural question (used to search the catalog)' })
  .option('expect', { type: 'string', default: '087600', describe: 'expected answer prefix' })
  .option('prompt', { type: 'string', default: '종목코드 픽셀플러스 ', describe: 'raw completion prompt for the model' })
  .option('api', { type: 'string', default: process.env.ENGRAM_API_PUBLIC ?? 'http://localhost:8000', describe: 'serving API (OpenAI-compatible)' })
  .option('patch', { type: 'string', describe: 'patch id to buy (skip search)' })
  .option('repo', { type: 'string', default: '/mnt/newdata/qwen3.8', describe: 'runtime repo with scripts/patch.py' })
  .option('keep', { type: 'boolean', default: false, describe: 'leave the patch applied' })
  .option('pay', { choices: ['auto', 'local-credit', 'ain-transfer'] as const, default: 'auto' })
  .option('ain-provider', { type: 'string', default: process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081' })
  .option('private-key', { type: 'string', describe: 'use this key instead of the stored identity' })
  .option('max-tokens', { type: 'number', default: 8 })
  .example('$0 run --market http://localhost:3402', 'default KRX demo (픽셀플러스 087600)')
  .example('$0 run --patch law-kr-2026 --question "한국법 개정" --expect never', 'buy a specific patch'),
async (a) => {
  const opts: AgentOptions = { market: a.market, question: a.question, expect: a.expect, prompt: a.prompt, api: a.api, patch: a.patch, repo: a.repo, keep: a.keep, home: a.home, pay: a.pay, ainProvider: a['ain-provider'], privateKey: a['private-key'], maxTokens: a['max-tokens'] };
  try {
    const res = await runAgent(opts, a.json ? () => undefined : (l) => process.stdout.write(l + '\n'));
    if (a.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.success ? 0 : 1);
  } catch (e) {
    process.stderr.write(chalk.red('agent failed: ') + (e as Error).message + '\n');
    process.exit(1);
  }
});

cli.command('catalog', 'List LISTED patches on the market', (y) => y.option('status', { type: 'string', default: 'LISTED' }), async (a) => {
  const items = await fetchCatalog(a.market, a.status);
  if (a.json) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return; }
  for (const e of items) process.stdout.write(`${chalk.cyan(e.anchor.id.padEnd(24))} ${e.status.padEnd(10)} ${String(e.anchor.rows).padStart(8)} rows  ${e.anchor.price} ${e.anchor.currency}  attest ${e.passed}/${e.quorum}  ${e.anchor.name}\n`);
  if (!items.length) process.stdout.write(chalk.gray('(no patches)\n'));
});

cli.command('balance', 'Show this agent\'s local-credit balance on a market (assumes the node\'s default 100 initial credit)', (y) => y.option('initial', { type: 'number', default: 100 }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  const bal = await creditBalance(a.market, id.address, a.initial);
  if (a.json) process.stdout.write(JSON.stringify({ address: id.address, balance: bal, currency: 'CREDIT', assumed_initial_credit: a.initial }) + '\n');
  else process.stdout.write(`${id.address}  ${bal} CREDIT ${chalk.gray(`(assuming ${a.initial} initial credit — the node does not expose market.initialCredit)`)}\n`);
});

cli.command('keys', 'Show (or create) the agent identity', (y) => y.option('reveal', { type: 'boolean', default: false }), async (a) => {
  const id = loadIdentity(agentHome(a.home));
  const out: Record<string, string> = { address: id.address, publicKey: id.publicKey, home: agentHome(a.home) };
  if (a.reveal) out.privateKey = id.privateKey;
  if (a.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else for (const [k, v] of Object.entries(out)) process.stdout.write(`${k.padEnd(11)} ${v}\n`);
});

await cli.parseAsync();
