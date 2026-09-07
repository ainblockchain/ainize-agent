/**
 * The shape key (design §5.1): the counter keys on the RETRIEVAL, not on the question.
 *
 * The property every test here circles: **the same lookup with a different argument is one shape**. If that fails,
 * every entity gets its own counter, the agent never notices it is repeating itself, and it never bakes anything —
 * which is the whole loop, so these are the tests that decide whether the loop can fire at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bindPlan, builtinPlansDir, graphqlSkeleton, isGraphQLDocument, loadPlans, parsePlan, planShape, shapeDescriptor,
  planSelfCheck, shapeKey, shapeOf, shortShape, skeleton, typedPlaceholder,
} from '../src/plans.js';

const ERC20 = parsePlan(JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')));

test('a leaf literal becomes what KIND of thing it was, never the value', () => {
  assert.equal(typedPlaceholder('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'), '$addr');
  assert.equal(typedPlaceholder('a'.repeat(64)), '$hash');
  assert.equal(typedPlaceholder('25903086'), '$int');
  assert.equal(typedPlaceholder('-0.5'), '$dec');
  assert.equal(typedPlaceholder('2026-09-07'), '$date');
  assert.equal(typedPlaceholder('2026-09-07T02:00:00Z'), '$date');
  assert.equal(typedPlaceholder('USDC'), '$str');
  assert.equal(skeleton(5), '$int');
  assert.equal(skeleton(0.5), '$dec');
  assert.equal(skeleton(true), '$bool');
  assert.equal(skeleton(null), null);
});

test('an object walks key-sorted, so the same call built in a different order is the same shape', () => {
  const a = { query: 'USDC', subgraph_id: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV' };
  const b = { subgraph_id: 'DiFfErEnTiDDiFfErEnTiDDiFfErEnT', query: 'WETH' };
  assert.deepEqual(skeleton(a), skeleton(b));
});

test('a list of ids is one placeholder, so asking about three deployments and asking about two is one shape', () => {
  const three = skeleton({ ipfs_hashes: ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o', 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'] });
  const two = skeleton({ ipfs_hashes: ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'] });
  assert.deepEqual(three, two);
  assert.deepEqual(three, { ipfs_hashes: ['$str'] }, 'a base58 id is not hex, so it is a $str — and three of them are one');
  assert.deepEqual(skeleton({ h: ['a'.repeat(64), 'b'.repeat(64)] }), { h: ['$hash'] }, 'a 64-hex id is a $hash');
});

test('a GraphQL document keeps its fields and loses its literals', () => {
  const doc = '{ _meta { block { number } } tokens(where: {symbol: "USDC"}, first: 3) { id symbol name } }';
  assert.ok(isGraphQLDocument(doc));
  const sk = graphqlSkeleton(doc);
  assert.ok(sk.includes('tokens'), 'the field name survives — asking for a different field IS a different shape');
  assert.ok(sk.includes('symbol'), 'the filter field survives');
  assert.ok(!sk.includes('USDC'), 'the value does not survive');
  assert.ok(!sk.includes(' 3'), 'the page size does not survive');
  assert.ok(sk.includes('"$str"') && sk.includes('$int'), 'both literals became typed placeholders');
});

test('the same query, formatted differently or commented, is the same shape', () => {
  const one = '{ _meta { block { number } } tokens(where: {symbol: "USDC"}, first: 3) { id symbol } }';
  const two = `{
      # written by a person, with a comment
      _meta   {  block { number } }
      tokens( where: { symbol: "WETH" } , first : 50 )  {
        id
        symbol
      }
    }`;
  assert.equal(graphqlSkeleton(one), graphqlSkeleton(two));
});

test('asking for one more field is a DIFFERENT shape', () => {
  const three = '{ tokens(first: 3) { id symbol name } }';
  const four = '{ tokens(first: 3) { id symbol name decimals } }';
  assert.notEqual(graphqlSkeleton(three), graphqlSkeleton(four));
});

test('`{symbol}` is a slot standing in for a value, not a GraphQL document', () => {
  assert.equal(isGraphQLDocument('{symbol}'), false);
  assert.equal(skeleton('{symbol}'), '$str');
});

// ----------------------------------------------------------------- the property the whole counter rests on

test('USDC today and WETH tomorrow are ONE shape, and it is the plan\'s own shape', () => {
  const usdc = shapeOf(bindPlan(ERC20, { symbol: 'USDC' }));
  const weth = shapeOf(bindPlan(ERC20, { symbol: 'weth' }));
  assert.equal(usdc, weth, 'a different entity must not start a new counter');
  assert.equal(usdc, planShape(ERC20), 'the plan and the call it makes agree on the shape');
  assert.equal(shortShape(usdc).length, 12);
  assert.match(usdc, /^[0-9a-f]{64}$/);
});

test('two plans that fetch the same field but ask a different question are two shapes', () => {
  const other = parsePlan({
    ...JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')),
    id: 'graph/erc20-decimals-by-symbol',
    mapping: { path: 'data.tokens', prompt: 'How many decimals does {symbol} use?', answer: '{decimals}', require: ['symbol', 'decimals'] },
  });
  assert.notEqual(planShape(other), planShape(ERC20), 'a different product must not share a counter');
});

test('the server and the tool are part of the shape', () => {
  const base = { server: ERC20.server, tool: ERC20.tool, arguments: ERC20.arguments, mapping: ERC20.mapping };
  const otherTool = shapeKey(shapeDescriptor({ ...base, tool: 'execute_query_by_deployment_id' }));
  const otherServer = shapeKey(shapeDescriptor({ ...base, server: 'someone-elses-mcp' }));
  assert.notEqual(otherTool, planShape(ERC20));
  assert.notEqual(otherServer, planShape(ERC20));
});

test('every plan that ships self-checks clean', () => {
  const { plans, errors } = loadPlans({ dirs: [builtinPlansDir()] });
  assert.deepEqual(errors, []);
  assert.ok(plans.length >= 1);
  for (const p of plans) {
    const findings = planSelfCheck(p);
    assert.deepEqual(findings, [], `${p.id}: ${findings.join(' · ')}`);
  }
});

// ------------------------------------------------------------------ a slot must not move the shape

test('a ticker made of digits is the same lookup as a ticker made of letters', () => {
  // Measured 2026-09-07 on the SHIPPED plan: `symbol: "USDC"` skeletonized to `"$str"` and `symbol: "1234"` to
  // `"$int"`, so a numeric ticker got its own lookup counter and its own row file — the counter would never reach a
  // threshold and a bake would have trained on part of the facts.
  const one = shapeOf(bindPlan(ERC20, { symbol: 'USDC' }));
  for (const symbol of ['WETH', '1INCH', '1234', '2026', '0x1234', '0.5', 'aaaaaaaaaaaaaaaa']) {
    assert.equal(shapeOf(bindPlan(ERC20, { symbol })), one, `${symbol} landed on a different counter from USDC`);
  }
});

test('a quoted GraphQL literal is a string because the quotes say so, not because of its characters', () => {
  const doc = (v: string) => `{ tokens(where: {symbol: ${JSON.stringify(v)}}, first: 5) { id } }`;
  const a = graphqlSkeleton(doc('USDC'));
  for (const v of ['1234', '2026-09-07', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'a'.repeat(64), '-0.5']) {
    assert.equal(graphqlSkeleton(doc(v)), a, `a quoted ${v} was typed as something other than a string`);
  }
  assert.match(a, /symbol:"\$str"/);
  // an UNQUOTED number is still a number, and paging is still not part of the shape
  assert.match(a, /first:\$int/);
  assert.equal(graphqlSkeleton(doc('USDC').replace('first: 5', 'first: 20')), a);
  // asking for a different FIELD is still a different shape
  assert.notEqual(graphqlSkeleton('{ tokens(where: {symbol: "USDC"}) { id } }'), graphqlSkeleton('{ tokens(where: {symbol: "USDC"}) { name } }'));
});

test('planSelfCheck tries values the slot really accepts, not only the one the plan suggested', () => {
  // A plan whose DATA SOURCE is a slot: two subgraphs, one plan, and — depending only on what the ids look like —
  // one counter or two. It has to be refused before it spends a query, not discovered afterwards.
  const raw = JSON.parse(readFileSync(join(builtinPlansDir(), 'graph-erc20.json'), 'utf8')) as Record<string, any>;
  const anySubgraph = parsePlan({
    ...raw, id: 'local/any-subgraph',
    arguments: { subgraph_id: '{sub}', query: raw.arguments.query },
    match: {
      patterns: ['{symbol} address on {sub}'], requires: ['symbol', 'sub'],
      slots: {
        symbol: raw.match.slots.symbol,
        sub: { pattern: '^[A-Za-z0-9]{1,64}$', max_length: 64, example: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV' },
      },
    },
  }, 'inline');
  const findings = planSelfCheck(anySubgraph);
  assert.equal(findings.length, 1, findings.join('; '));
  assert.match(findings[0], /\{sub\} moves the shape/);
  assert.match(findings[0], /two different counters/);
  // …and the shipped plan, whose one slot lands inside a quoted GraphQL literal, is clean
  assert.deepEqual(planSelfCheck(ERC20), []);
});
