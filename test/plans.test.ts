/**
 * Plans: the schema, the loader, and the honest half of the matcher (design §5.1, §5.2).
 *
 * The matcher collapses phrasings somebody WROTE DOWN, in English and Korean, and nothing else. So these tests are
 * mostly about the two answers that cost nothing and must be right: which plan a question binds to, and when the
 * agent refuses to ask anything at all — because the alternative is guessing a query with somebody else's API key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindPlan, builtinPlansDir, checkSlot, compilePattern, declaredSlots, foldQuestion, loadPlans, matchQuestion,
  parsePlan, PlanError, planSelfCheck, referencedSlots, type AgentPlan,
} from '../src/plans.js';

const RAW = JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')) as Record<string, unknown>;
const ERC20 = parsePlan(RAW, join(builtinPlansDir(), 'graph-erc20.json'));
const PLANS = [ERC20];

// ------------------------------------------------------------------------------------------------ the schema

test('the shipped plan loads, names its file, and declares exactly the slot its call uses', () => {
  const { plans, errors, dirs } = loadPlans({ dirs: [builtinPlansDir()] });
  assert.deepEqual(errors, []);
  assert.ok(dirs[0]?.endsWith('/plans/'));
  const plan = plans.find((p) => p.id === 'graph/erc20-address-by-symbol');
  assert.ok(plan, 'the built-in ERC-20 plan is there');
  assert.equal(plan.server.name, 'subgraph-mcp');
  assert.equal(plan.tool, 'execute_query_by_subgraph_id');
  assert.deepEqual([...declaredSlots(plan)], ['symbol']);
  assert.deepEqual([...referencedSlots(plan)], ['symbol']);
  assert.ok(plan.file?.endsWith('graph-erc20.json'));
});

test('a plan may name the environment variable that holds a key, never a key', () => {
  assert.throws(
    () => parsePlan({ ...RAW, server: { ...(RAW.server as object), auth_env: ['deadbeefdeadbeef'] } }),
    (e: unknown) => e instanceof PlanError && e.code === 'plan_secret_in_plan',
  );
});

test('a plan whose call uses a slot no pattern captures is refused before it can spend anything', () => {
  assert.throws(
    () => parsePlan({ ...RAW, arguments: { subgraph_id: '{network}', query: '{ tokens { id } }' } }),
    (e: unknown) => e instanceof PlanError && /uses \{network\}/.test((e as Error).message),
  );
});

test('every other refusal names the plan, the field and what was wrong', () => {
  const cases: [unknown, RegExp][] = [
    [{ ...RAW, id: 'Not An Id' }, /"id" must be a lowercase path-like name/],
    [{ ...RAW, server: { ...(RAW.server as object), transport: 'carrier-pigeon' } }, /server\.transport must be/],
    [{ ...RAW, server: { name: 'x', transport: 'sse', url: 'ftp://nope' } }, /server\.url must be an http/],
    [{ ...RAW, mapping: { path: 'data.tokens', answer: '{id}' } }, /mapping\.prompt is required/],
    [{ ...RAW, match: { patterns: [] } }, /match\.patterns must be a non-empty list/],
    [{ ...RAW, match: { patterns: ['{symbol} address'], requires: ['chain'] } }, /match\.requires names \{chain\}/],
  ];
  for (const [doc, re] of cases) assert.throws(() => parsePlan(doc), re);
});

test('a bad file is reported and the plans beside it still load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-plans-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ ...RAW, id: 'local/other' }));
  const { plans, errors } = loadPlans({ dirs: [dir] });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.id, 'local/other');
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.file.endsWith('broken.json'));
});

test('a plan in the agent home replaces the shipped plan of the same id, and says which file won', () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-home-'));
  mkdirSync(join(home, 'plans'));
  writeFileSync(join(home, 'plans', 'mine.json'), JSON.stringify({ ...RAW, description: 'the owner\'s own version' }));
  const { plans } = loadPlans({ home });
  const plan = plans.find((p) => p.id === ERC20.id) as AgentPlan;
  assert.equal(plan.description, 'the owner\'s own version');
  assert.ok(plan.file?.startsWith(home));
});

// ------------------------------------------------------------------------------------------- question → plan

test('the phrasings the plan declares bind the ticker, in English and in Korean', () => {
  const questions = [
    'What is the contract address of USDC?',
    'what is the contract address of the usdc token',
    'contract address of usdc',
    'USDC contract address',
    'USDC 컨트랙트 주소',
    'USDC 컨트랙트 주소 알려줘',
    'USDC 토큰의 컨트랙트 주소는?',
    'ＵＳＤＣ 컨트랙트 주소',            // full width, folded by NFKC
    'usdc컨트랙트주소',                  // Korean spacing is optional
  ];
  for (const q of questions) {
    const { matches } = matchQuestion(PLANS, q);
    assert.ok(matches.length, `no plan matched ${JSON.stringify(q)}`);
    assert.equal(matches[0]?.plan.id, ERC20.id);
    assert.equal(matches[0]?.slots.symbol, 'USDC', `${JSON.stringify(q)} bound ${matches[0]?.slots.symbol}`);
  }
});

test('a question nobody wrote a phrasing for is not retrieved at all', () => {
  for (const q of ['who deployed USDC and when', 'USDC 시가총액', 'what is the price of ETH']) {
    const { matches, refusals } = matchQuestion(PLANS, q);
    assert.deepEqual(matches, [], `${q} should match nothing`);
    assert.deepEqual(refusals.filter((r) => r.reason === 'empty'), []);
  }
});

test('a slot that would break out of the GraphQL string is refused, and the refusal is recorded', () => {
  const short = matchQuestion(PLANS, 'contract address of usdc"');
  assert.deepEqual(short.matches, [], 'nothing is asked upstream');
  assert.equal(short.refusals[0]?.slot, 'symbol');
  assert.match(short.refusals[0]?.reason ?? '', /does not match/, 'a quote is not a ticker');

  const long = matchQuestion(PLANS, 'contract address of usdc" }) { id } # ');
  assert.deepEqual(long.matches, []);
  assert.match(long.refusals[0]?.reason ?? '', /longer than 16 characters/, 'and the plan\'s own ceiling catches the rest');
});

test('the most literal match wins, deterministically, and the alternatives are still visible', () => {
  const generic = parsePlan({
    ...RAW,
    id: 'local/anything-address',
    match: { patterns: ['{thing} address'], requires: ['thing'], slots: { thing: { example: 'usdc' } } },
    arguments: { subgraph_id: 'x', query: '{ tokens(where: {symbol: "{thing}"}) { id symbol name } }' },
  });
  const { matches } = matchQuestion([generic, ERC20], 'USDC contract address');
  assert.ok(matches.length >= 2, 'both plans match');
  assert.equal(matches[0]?.plan.id, ERC20.id, '"contract address" is more literal text than "address"');
  const again = matchQuestion([ERC20, generic], 'USDC contract address');
  assert.equal(again.matches[0]?.plan.id, ERC20.id, 'and the order the plans were loaded in does not decide it');
});

test('folding is declared in one place: NFKC, lower case, collapsed spaces, one trailing question mark', () => {
  assert.equal(foldQuestion('  What   is  THIS? '), 'what is this');
  assert.equal(foldQuestion('ＵＳＤＣ'), 'usdc');
  assert.equal(foldQuestion('USDC 주소?!'), 'usdc 주소');
});

test('a pattern captures each slot once, non-greedily, and is anchored', () => {
  const c = compilePattern('what is the contract address of {symbol}');
  assert.deepEqual(c.slots, ['symbol']);
  assert.ok(c.literal_length > 0);
  assert.equal(c.regex.exec('what is the contract address of usdc and weth')?.groups?.symbol, 'usdc and weth');
  assert.equal(c.regex.exec('and what is the contract address of usdc'), null, 'anchored at the front');
  assert.throws(() => compilePattern('{a} and {a}'), /captures \{a\} twice/);
});

test('a slot value is checked before it is transformed, and 64 characters is the default ceiling', () => {
  assert.deepEqual(checkSlot('symbol', ' usdc ', { transform: 'upper' }), { ok: true, value: 'USDC' });
  assert.equal(checkSlot('symbol', 'x'.repeat(80), undefined).ok, false);
  assert.equal(checkSlot('symbol', 'US"DC', undefined).ok, false);
  assert.equal(checkSlot('symbol', 'a b', undefined).ok, true, 'a space is allowed by the default rule; a quote is not');
});

// ------------------------------------------------------------------------------------------------- binding

test('binding fills the call and leaves the row templates alone', () => {
  const bound = bindPlan(ERC20, { symbol: 'usdc' });
  const query = (bound.arguments as { query: string }).query;
  assert.match(query, /symbol: "USDC"/, 'the slot is substituted, upper-cased as the plan asked');
  assert.ok(!query.includes('{symbol}'));
  assert.equal(bound.mapping.prompt, ERC20.mapping.prompt, 'the row template still says {name} and {symbol}');
  assert.match(bound.mapping.prompt, /\{symbol\}/, 'mapRows renders those from the upstream item, not from the question');
  assert.equal(bound.upstream.network, 'ethereum');
  assert.equal(bound.slots.symbol, 'USDC');
});

test('an unusable or missing slot never reaches the wire', () => {
  assert.throws(() => bindPlan(ERC20, { symbol: 'US"DC' }), (e: unknown) => e instanceof PlanError && e.code === 'plan_slot_refused');
  assert.throws(() => bindPlan(ERC20, {}), (e: unknown) => e instanceof PlanError && e.code === 'plan_slot_missing');
});

test('planSelfCheck catches a plan whose counter would never fire', () => {
  // the slot lands OUTSIDE a string literal, so USDC and WETH would skeletonise differently and each entity would
  // get its own counter — the failure mode that makes the whole loop silently never bake.
  const broken = parsePlan({
    ...RAW,
    id: 'local/unquoted-slot',
    arguments: { subgraph_id: 'x', query: '{ tokens(first: {count}) { id symbol name } }' },
    match: { patterns: ['{count} tokens'], requires: ['count'], slots: { count: { pattern: '^[0-9]{1,3}$', example: '5' } } },
  });
  assert.deepEqual(planSelfCheck(ERC20), [], 'the shipped plan is clean: its slot sits inside a string literal');
  const findings = planSelfCheck(broken);
  assert.equal(findings.length, 1, findings.join(' · '));
  assert.match(findings[0] as string, /changes the shape/);
});
