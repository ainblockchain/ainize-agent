/**
 * Retrieval: the counters, the budget, and what is written down (design §5.3, §7).
 *
 * The transport is NOT re-tested here — `packages/mcp/test/datasource.test.ts` drives `McpDataSource` against a
 * real MCP server, and `test/smoke-subgraph-mcp.test.ts` drives it against The Graph. What is tested here is the
 * part that is this agent's own: one reservation per query, `new_rows`/`refetched`/`churned` against the memory it
 * carries, the pinning facts lifted out of the same answer the rows came from, and a memory line that stays a line.
 *
 * The last test in the file is live and skips without `GRAPH_API_KEY` — it is never replaced by a fixture, which is
 * the rule `graph/README.md` sets and `smoke-subgraph-mcp.test.ts` already follows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argumentsSha256, McpDataSourceError, type McpCallResult } from '@ngram/mcp/client';
import { builtinPlansDir, loadPlans, parsePlan, type AgentPlan } from '../src/plans.js';
import {
  capProvenance, datasetForShape, explainNoPlan, planForQuestion, retrieve, shapeFiles,
  type BudgetHold, type LearnEvent, type QueryBudget, type RetrieveEvent, type RetrievalSource, type RetrieveMemory,
} from '../src/retrieve.js';

const ERC20 = loadPlans({ dirs: [builtinPlansDir()] }).plans.find((p) => p.id === 'graph/erc20-address-by-symbol') as AgentPlan;

const TOKENS = (usdc: string) => ({
  data: {
    _meta: { block: { number: 25903086 } },
    tokens: [
      { id: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
      { id: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 },
    ],
  },
});
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

/** A stand-in for the MCP client: it answers with what the test hands it and counts what it was asked. */
function fakeSource(answer: unknown | (() => never), opts: { isError?: boolean; text?: string } = {}): RetrievalSource & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async connect() { return {}; },
    async call(tool, args): Promise<McpCallResult> {
      calls.push({ tool, args });
      if (typeof answer === 'function') (answer as () => never)();
      const text = opts.text ?? JSON.stringify(answer);
      return {
        text, json: opts.text ? null : answer, content: [{ type: 'text', text }], isError: !!opts.isError, elapsed_ms: 7,
        provenance: { source: 'mcp', server: { name: 'subgraph-mcp', url: 'https://example.invalid/sse', transport: 'sse', protocol_version: '2024-11-05', authenticated: true }, tool, arguments: args, arguments_sha256: argumentsSha256(args), fetched_at: Date.now() },
      };
    },
    async close() { /* the caller owns this one */ },
  };
}

function fakeMemory(): RetrieveMemory & { rows: Map<string, { answer: string }>; events: (RetrieveEvent | LearnEvent)[] } {
  const rows = new Map<string, { answer: string }>();
  const events: (RetrieveEvent | LearnEvent)[] = [];
  return {
    rows, events,
    row: (k) => rows.get(k) ?? null,
    append(e) {
      events.push(e);
      if (e.kind === 'learn') rows.set(e.row_key, { answer: e.answer });
    },
  };
}

function fakeBudget(cap: number): QueryBudget & { ledger: string[]; spent: number } {
  const state = { ledger: [] as string[], spent: 0, reserved: 0 };
  return {
    get ledger() { return state.ledger; },
    get spent() { return state.spent; },
    reserve(kind, amount, forWhat): BudgetHold {
      if (state.spent + state.reserved + amount > cap) throw new Error(`${kind}: ${amount} would pass today's cap of ${cap}`);
      state.reserved += amount;
      state.ledger.push(`intent ${kind} ${amount} ${forWhat}`);
      return {
        settle(actual) { state.reserved -= amount; state.spent += actual ?? amount; state.ledger.push(`settled ${kind} ${actual ?? amount}`); },
        release() { state.reserved -= amount; state.ledger.push(`released ${kind} ${amount}`); },
      };
    },
  };
}

const home = (): string => mkdtempSync(join(tmpdir(), 'ainize-retrieve-'));

// ------------------------------------------------------------------------------------------------ counters

test('the first pull is all new; the second is all refetched; a changed answer is churn', async () => {
  const h = home();
  const memory = fakeMemory();
  const budget = fakeBudget(10);

  const first = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget, memory, source: fakeSource(TOKENS(USDC)) });
  assert.equal(first.rows.length, 3);
  assert.deepEqual([first.new_rows, first.refetched, first.churned], [3, 0, 0]);
  assert.equal(first.primary?.answer, USDC);
  assert.match(first.primary?.prompt ?? '', /USD Coin \(USDC\)/, 'the row says which fact answered');

  const second = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget, memory, source: fakeSource(TOKENS(USDC)) });
  assert.deepEqual([second.new_rows, second.refetched, second.churned], [0, 3, 0], 'this agent has now paid twice for the same three facts');
  assert.equal(second.shape, first.shape, 'and it is the same shape, so the counter can see it');

  const moved = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget, memory, source: fakeSource(TOKENS('0x1111111111111111111111111111111111111111')) });
  assert.deepEqual([moved.new_rows, moved.refetched, moved.churned], [0, 3, 1], 'one answer moved underneath');

  const events = memory.events.filter((e) => e.kind === 'retrieve') as RetrieveEvent[];
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.queries), [1, 1, 1]);
  assert.equal(events[2]?.churned, 1);
  const learns = memory.events.filter((e) => e.kind === 'learn') as LearnEvent[];
  assert.equal(learns.length, 4, 'three facts, plus the one that changed — a fact that came back identical teaches nothing new');
});

test('a different entity is the same shape and lands in the same row set', async () => {
  const h = home();
  const memory = fakeMemory();
  const a = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', memory, source: fakeSource(TOKENS(USDC)) });
  const b = await retrieve({
    plan: ERC20, slots: { symbol: 'WBTC' }, home: h, budget: 'unmetered', memory,
    source: fakeSource({ data: { _meta: { block: { number: 25903090 } }, tokens: [{ id: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8 }] } }),
  });
  assert.equal(b.shape, a.shape);
  assert.equal(b.rows_file, a.rows_file);
  const dataset = datasetForShape(h, a.shape);
  assert.equal(dataset.rows.length, 4, 'three tokens plus the fourth, de-duplicated on the node\'s own prompt key');
  assert.equal(dataset.unreadable, 0);
});

test('the freshest answer wins in the dataset a bake would train on', async () => {
  const h = home();
  const memory = fakeMemory();
  await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', memory, source: fakeSource(TOKENS(USDC)) });
  await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', memory, source: fakeSource(TOKENS('0x9999999999999999999999999999999999999999')) });
  const { rows } = datasetForShape(h, (await Promise.resolve(memory.events.find((e) => e.kind === 'retrieve') as RetrieveEvent)).shape);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.answer, '0x9999999999999999999999999999999999999999');
});

// ------------------------------------------------------------------------------------------------ provenance

test('the rows are pinned to the block of the very answer they came from', async () => {
  const h = home();
  const out = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', source: fakeSource(TOKENS(USDC)) });
  assert.equal(out.provenance.upstream?.block, 25903086);
  assert.equal(out.provenance.upstream?.subgraph_id, '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV');
  assert.deepEqual(out.unpinned, []);
  for (const row of out.rows) {
    assert.match(String(row.note), /via MCP subgraph-mcp · execute_query_by_subgraph_id · subgraph_id 5zvR82.* · block 25903086 · args [0-9a-f]{12}/);
  }
  assert.equal(out.provenance.rows, 3);
  assert.equal(out.provenance.row_hashes.length, 3);

  const stored = readFileSync(shapeFiles(h, out.shape).provenance, 'utf8').trim().split('\n');
  assert.equal(stored.length, 1);
  const record = JSON.parse(stored[0] as string) as { provenance: { arguments: { query: string } }; slots: Record<string, string> };
  assert.match(record.provenance.arguments.query, /symbol: "USDC"/, 'the complete record keeps the query text a buyer would re-run');
  assert.deepEqual(record.slots, { symbol: 'USDC' });
});

test('an answer that cannot pin the rows says so instead of inventing a block', async () => {
  const h = home();
  const out = await retrieve({
    plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered',
    source: fakeSource({ data: { tokens: TOKENS(USDC).data.tokens } }),
  });
  assert.deepEqual(out.unpinned, ['block']);
  assert.equal(out.provenance.upstream?.block, undefined);
  assert.ok(!String(out.rows[0]?.note).includes('block'));
});

test('the memory LINE stays a line, and the full record it points at keeps everything', () => {
  const rows = 200;
  const p = {
    source: 'mcp' as const,
    server: { name: 'subgraph-mcp', url: 'https://example.invalid/sse', transport: 'sse' as const, protocol_version: '2024-11-05', authenticated: true },
    tool: 'execute_query_by_subgraph_id',
    arguments: { query: 'x'.repeat(4000) },
    arguments_sha256: 'a'.repeat(64),
    fetched_at: 1_757_000_000_000,
    upstream: { subgraph_id: '5zvR82', block: 25903086 },
    row_hashes: Array.from({ length: rows }, (_, i) => String(i).padStart(64, '0')),
    rows_sha256: 'b'.repeat(64),
    rows,
  };
  const capped = capProvenance(p, '/home/agent/retrieved/abc.provenance.jsonl');
  const line = JSON.stringify({ v: 1, at: Date.now(), kind: 'retrieve', provenance: capped });
  assert.ok(line.length < 2048, `a memory line is ${line.length} bytes`);
  assert.equal(capped.row_hashes?.length, 8);
  assert.equal(capped.row_hashes_omitted, 192);
  assert.equal(capped.record, '/home/agent/retrieved/abc.provenance.jsonl');
  assert.equal((capped as unknown as { arguments?: unknown }).arguments, undefined, 'the 4 kB query text is not in the line');
  assert.equal(capped.arguments_sha256, 'a'.repeat(64), 'and it is still identified exactly');
});

test('a second phrasing two different answers both claim is dropped, and the rows are kept', async () => {
  // Measured live on 2026-09-07: `symbol: "WETH"` on Uniswap v3 returns "Wrapped Ether" AND "Wrapped Ether from
  // PulseChain". Their English prompts differ by name; a Korean alternative written without the name does not.
  const plan = parsePlan({
    ...(JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')) as Record<string, unknown>),
    id: 'local/colliding-alt',
    mapping: {
      path: 'data.tokens', prompt: 'What is the contract address of the {name} ({symbol}) token?', answer: '{id}',
      alt_prompt: '{symbol} 토큰의 컨트랙트 주소는?', require: ['id', 'symbol', 'name'],
    },
  });
  const out = await retrieve({
    plan, slots: { symbol: 'WETH' }, home: home(), budget: 'unmetered',
    source: fakeSource({ data: { _meta: { block: { number: 1 } }, tokens: [
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether' },
      { id: '0xb1a7f8b3ada1cbd7752c1306725b07d2f8b4e726', symbol: 'WETH', name: 'Wrapped Ether from PulseChain' },
    ] } }),
  });
  assert.equal(out.rows.length, 2, 'both facts are kept — their own prompts say which token they are about');
  assert.equal(out.alt_collisions, 2);
  assert.deepEqual(out.rows.map((r) => r.alt_prompt), [undefined, undefined], 'the one question with two answers is gone');

  const fine = await retrieve({
    plan, slots: { symbol: 'WETH' }, home: home(), budget: 'unmetered',
    source: fakeSource({ data: { _meta: { block: { number: 1 } }, tokens: [
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether' },
      { id: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', name: 'Dai Stablecoin' },
    ] } }),
  });
  assert.equal(fine.alt_collisions, 0);
  assert.equal(fine.rows[0]?.alt_prompt, 'WETH 토큰의 컨트랙트 주소는?', 'an alternative nobody else claims survives');
});

// ------------------------------------------------------------------------------------------------ the budget

test('one query is reserved before the call and settled after it', async () => {
  const budget = fakeBudget(10);
  const source = fakeSource(TOKENS(USDC));
  await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: home(), budget, source });
  assert.deepEqual(budget.ledger, ['intent queries 1 graph/erc20-address-by-symbol · execute_query_by_subgraph_id', 'settled queries 1']);
  assert.equal(budget.spent, 1);
  assert.equal(source.calls.length, 1, 'exactly one call, so exactly one query');
});

test('a budget that refuses stops the call from being made at all', async () => {
  const budget = fakeBudget(0);
  const source = fakeSource(TOKENS(USDC));
  await assert.rejects(
    retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: home(), budget, source }),
    /would pass today's cap of 0/,
  );
  assert.equal(source.calls.length, 0, 'nothing was asked');
  assert.equal(budget.spent, 0, 'and nothing was spent');
});

test('a query that left and failed is counted; one that never left is given back', { timeout: 30_000 }, async () => {
  const spent = fakeBudget(10);
  await assert.rejects(retrieve({
    plan: ERC20, slots: { symbol: 'USDC' }, home: home(), budget: spent,
    source: fakeSource(() => { throw new Error('the upstream index is down'); }),
  }), /index is down/);
  assert.deepEqual(spent.ledger.at(-1), 'settled queries 1');

  // A server that cannot be reached at all. `stdio` and a command that does not exist, deliberately: an SSE URL
  // that refuses the connection is retried by `eventsource` until it gives up, and a test that waits on a network
  // stack is a test that hangs somebody else's suite.
  const unreachable = fakeBudget(10);
  const offline = parsePlan({
    ...(JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')) as Record<string, unknown>),
    id: 'local/unreachable',
    server: { name: 'nowhere', transport: 'stdio', command: '/nonexistent/ainize-no-such-mcp-server' },
  });
  await assert.rejects(retrieve({ plan: offline, slots: { symbol: 'USDC' }, home: home(), budget: unreachable }), /could not connect|ENOENT/);
  assert.deepEqual(unreachable.ledger.at(-1), 'released queries 1');
  assert.equal(unreachable.spent, 0);
});

// ------------------------------------------------------------------------------------------------ refusals

test('a tool error and a non-JSON answer are refused with the client\'s own codes, and nothing is stored', async () => {
  const h = home();
  await assert.rejects(
    retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', source: fakeSource(null, { isError: true, text: 'the index is behind' }) }),
    (e: unknown) => e instanceof McpDataSourceError && e.code === 'mcp_tool_error',
  );
  await assert.rejects(
    retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget: 'unmetered', source: fakeSource(null, { text: '<html>502</html>' }) }),
    (e: unknown) => e instanceof McpDataSourceError && e.code === 'mcp_not_json',
  );
  assert.equal(existsSync(join(h, 'retrieved')), false, 'a failed retrieval leaves no rows behind');
});

test('a question no plan matches is answered with the plans the agent has, in the reader\'s language', () => {
  const plans = [ERC20];
  const outcome = planForQuestion(plans, 'what is the price of ETH right now');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, 'no_plan');
  const en = explainNoPlan(plans, outcome, 'en');
  assert.match(en.join(' '), /no plan matches this question/);
  assert.match(en.join(' '), /graph\/erc20-address-by-symbol/);
  const ko = explainNoPlan(plans, outcome, 'ko');
  assert.match(ko.join(' '), /맞는 plan 이 없어/);
});

test('a matched question carries its slots and its alternatives', () => {
  const outcome = planForQuestion([ERC20], 'USDC 컨트랙트 주소 알려줘');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.candidate.plan.id, ERC20.id);
  assert.deepEqual(outcome.candidate.slots, { symbol: 'USDC' });
});

// ------------------------------------------------------------------------------------------------ live

const KEY = process.env.GRAPH_API_KEY ?? process.env.THEGRAPH_GATEWAY_API_KEY ?? '';
test('live: the shipped plan answers a real question against The Graph, once, and pins it to a block', {
  skip: KEY ? false : 'no GRAPH_API_KEY in the environment (this test is never replaced by a fixture)',
  timeout: 180_000,
}, async () => {
  const h = home();
  const budget = fakeBudget(1);
  const out = await retrieve({ plan: ERC20, slots: { symbol: 'USDC' }, home: h, budget, log: (l) => console.log('   ' + l) });
  assert.ok(out.rows.length >= 1, 'the query found the token');
  assert.match(out.primary?.answer ?? '', /^0x[0-9a-f]{40}$/);
  assert.equal(typeof out.provenance.upstream?.block, 'number');
  assert.equal(out.queries, 1);
  assert.equal(budget.spent, 1);
  assert.equal(datasetForShape(h, out.shape).rows.length, out.rows.length);
});
