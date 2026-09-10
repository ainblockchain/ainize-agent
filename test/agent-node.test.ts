/**
 * The agent, driven end to end against a real node in this process.
 *
 * These cases used to live in `@ainize/cli`'s suite — not because the CLI owned them, but because that is where
 * somebody had already written `startNode` + `seedDemo`. The split made the cost visible: `ainize-cli` had to
 * devDepend on `@ainize/agent` to run tests about the agent, an edge pointing the wrong way through the whole
 * dependency graph. The harness is two exported functions, so it moved here instead.
 *
 * `@ainize/node` is a devDependency for this file alone: what these prove is that the agent's buy loop, its
 * receipts and its budget behave against a node that really answers 402s, which cannot be checked from inside
 * the agent alone.
 *
 *   node --test --import tsx test/agent-node.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig, teachConfig, writeNpz, type NodeConfig } from '@ainize/core';
import { startNode, seedDemo, type RunningNode } from '@ainize/node';
import {
  runAgent, creditBalance, fetchInitialCredit, pickPatch, fetchCatalog, checkRequirement, exitCodeFor,
  readPurchases, spentToday, agentBalance, sellerError, newestOnTrack, watchAgent, loadIdentity,
} from '../src/index.js';

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v) || Date.now() - t0 > ms) return v; await sleep(200); }
}

const tmp = mkdtempSync(join(tmpdir(), 'ainize-agent-node-test-'));
const home = join(tmp, 'home');
const agentHome = join(tmp, 'agent');
let node: RunningNode;
let port: number;

before(async () => {
  port = await freePort();
  // quorum 1 with self-attest, so the node lists its own seeded patches and the agent has something to buy
  const cfg: NodeConfig = defaultConfig({ home, name: 'agent-test-node', port, ledger: 'local', roles: ['seller', 'verifier'] });
  cfg.host = '127.0.0.1';
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300 };
  cfg.gossipIntervalMs = 60_000;
  cfg.teach = { ...teachConfig(cfg), enabled: false };
  saveConfig(cfg, home);
  node = await startNode(cfg, { home, quiet: true, serveWeb: false });
  await seedDemo(node.market, { real: false, synthetic: true });
  await waitFor(() => node.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2026')?.status === 'LISTED', 30000);
});
after(async () => { await node?.stop(); rmSync(tmp, { recursive: true, force: true }); });

/** The smallest well-formed patch body: one address, one row of weights that actually moved. */
function tinyNpz(path: string, addr: bigint, D = 160): void {
  const a = Buffer.alloc(8); a.writeBigInt64LE(addr);
  const before = Buffer.alloc(4 * D); const after = Buffer.alloc(4 * D); for (let i = 0; i < D; i++) after.writeFloatLE(0.02, 4 * i);
  writeNpz(path, [{ name: 'addrs', descr: '<i8', shape: [1], body: a }, { name: 'before', descr: '<f4', shape: [1, D], body: before }, { name: 'after', descr: '<f4', shape: [1, D], body: after }]);
}

test('agent: picks a patch, pays with local-credit over 402, downloads and verifies the body', async () => {
  const market = `http://127.0.0.1:${port}`;
  const items = await fetchCatalog(market);
  assert.equal(pickPatch(items, '한국법 개정 2026')?.anchor.id, 'law-kr-2026');
  const id = loadIdentity(agentHome);
  const before = await creditBalance(market, id.address);
  const lines: string[] = [];
  const res = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome }, (l) => lines.push(l));
  // Item 284: the purchase loop completed and no model has the knowledge — `downloaded`, not `success`.
  assert.equal(res.outcome, 'downloaded', lines.join('\n'));
  assert.equal(res.scheme, 'local-credit');
  assert.equal(res.patch_id, 'law-kr-2026');
  assert.ok(res.path && existsSync(res.path));
  assert.equal(res.sha256, items.find((e) => e.anchor.id === 'law-kr-2026')!.anchor.patch_sha256);
  assert.ok(lines.some((l) => l.includes('402 Payment Required')));
  const after = await waitFor(() => creditBalance(market, id.address), (b) => b < before);
  assert.equal(Math.round((before - after) * 1000) / 1000, 2.5);
  // the seller recorded the settlement
  const setts = await node.ledger.settlements('law-kr-2026');
  assert.equal(setts.length, 1);
  assert.equal(setts[0].body.buyer, id.address);
  // Item 231: the SECOND run of the same command pays nothing — the receipt in purchases.jsonl is checked before
  // the gateway is touched. (It used to buy again on a fresh nonce, so a cron line was a standing order.)
  const lines2: string[] = [];
  const again = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome }, (l) => lines2.push(l));
  assert.ok(again.owned, lines2.join('\n'));
  assert.equal((await node.ledger.settlements('law-kr-2026')).length, 1, 'no second settlement: the agent knew it owned it');
  assert.equal(Math.round((await creditBalance(market, id.address)) * 1000) / 1000, Math.round(after * 1000) / 1000);
  // …and --repay is the deliberate second purchase.
  const repaid = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', repo: join(tmp, 'no-repo'), home: agentHome, repay: true }, () => undefined);
  assert.ok(!repaid.owned);
  assert.equal((await node.ledger.settlements('law-kr-2026')).length, 2);
});

test('agent: a purchase leaves a receipt the agent can read back, and a run that loaded nothing exits 3 (items 231, 284, 286)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const rows = readPurchases(agentHome);
  assert.ok(rows.length >= 1, 'purchases.jsonl has the receipt');
  const r = rows.find((x) => x.patch_id === 'law-kr-2026')!;
  assert.ok(r, 'the receipt names the knowledge');
  assert.equal(r.seller, node.cfg.identity.address, 'and who was paid — the row the node itself does not store');
  assert.equal(r.asset, 'CREDIT');
  assert.ok(existsSync(r.path));
  assert.ok(spentToday(agentHome).CREDIT >= 2.5);
  // Item 284: the body is on disk and no model has it. That is not a success, and the exit code says so.
  const res = await runAgent({ market, patch: 'law-kr-2026', question: 'synthetic', expect: 'never', prompt: 'x', api: 'http://127.0.0.1:1', home: agentHome }, () => undefined);
  assert.equal(res.outcome, 'downloaded');
  assert.equal(res.success, false);
  assert.equal(exitCodeFor(res), 3);
  assert.equal(exitCodeFor(res, true), 0, '--download-only asked for exactly this');
});

test('agent: the 402 may not ask for more than the record, nor point the money elsewhere (item 290)', async () => {
  const items = await fetchCatalog(`http://127.0.0.1:${port}`);
  const e = items.find((x) => x.anchor.id === 'law-us-2025')!;
  const req = (amount: string, payTo: string) => ({
    scheme: 'local-credit' as const, network: 'local', resource: `/x402/patch/${e.anchor.id}`, description: '', mimeType: 'application/json',
    payTo, maxAmountRequired: amount, asset: 'CREDIT', nonce: 'n1', maxTimeoutSeconds: 60,
  });
  const gw = 'http://seller.example/x402';
  // the price on the record is what the agent will pay — never what a gateway asks for on top of it
  assert.throws(() => checkRequirement(req('999', e.anchor.author), e, gw), /refusing to pay more than the record/);
  // …nor a payment redirected to somebody who did not publish it
  assert.throws(() => checkRequirement(req(e.anchor.price, '0x' + '9'.repeat(40)), e, gw), /a payment to anyone but the anchor's author buys nothing/);
  // …nor anything over the budget the caller set
  assert.throws(() => checkRequirement(req(e.anchor.price, e.anchor.author), e, gw, 0.0001), /over --max-price/);
  assert.doesNotThrow(() => checkRequirement(req(e.anchor.price, e.anchor.author.toUpperCase()), e, gw));
});

test('agent: --patch with no --prompt measures the knowledge against its own benchmark, and --track names a channel (items 233, 266)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const file = join(tmp, 'agent-bench.npz'); tinyNpz(file, 909n);
  const bench = join(tmp, 'agent-bench.json');
  writeFileSync(bench, JSON.stringify({ schema: 'cli-agent-bench', queries: 1, format: ['template'], samples: [{ prompt: '종목코드 스핀들 ', expect: '999999' }] }));
  // Published through the node's own market, not the CLI: the publish is setup, and every assertion below is
  // about the agent. Reaching for `patchPublish` here is what used to make this suite need `@ainize/cli`.
  const draft = await node.market.createDraft({
    id: 'cli-agent-bench', name: 'agent bench', file,
    model: { id_M: 'Qwen3.8-Flash-Next' },
    benchmark: JSON.parse(readFileSync(bench, 'utf8')),
  });
  await node.market.announce(draft.id);
  const lines: string[] = [];
  // it is not verified (a declared benchmark needs a real run, and this node has no model), so the run stops there —
  // but the prompt and the expected value it was going to measure came from the KNOWLEDGE, not from the demo.
  await assert.rejects(runAgent({ market, patch: 'cli-agent-bench', api: 'http://127.0.0.1:1', home: join(tmp, 'agent-233') }, (l) => lines.push(l)), /not verified|quorum/);
  assert.ok(lines.some((l) => l.includes('종목코드 스핀들') && l.includes('999999')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("cli-agent-bench's own benchmark (sample 1 of 1)")), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('픽셀플러스')), 'the Pixelplus demo has no business in a run that named a knowledge');
  // item 266: a track can be named instead of an id that goes stale overnight
  const items = await fetchCatalog(market);
  assert.equal((await newestOnTrack(market, 'law/KR', items)).anchor.id, 'law-kr-2026');
  await assert.rejects(newestOnTrack(market, 'law/NOPE', items), /no track called/);
});

test('agent watch: buys what is missing under a daily budget, never twice, and decides from its own receipts (item 287)', async () => {
  const market = `http://127.0.0.1:${port}`;
  const home = join(tmp, 'agent-watch');
  // a budget smaller than the price is a refusal, not a purchase
  const tight = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 0.5 }, () => undefined);
  assert.equal(tight[0].actions[0].action, 'over_budget');
  assert.equal(readPurchases(home).length, 0);
  // with room in the budget it buys once…
  const first = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.equal(first[0].actions[0].action, 'bought');
  assert.equal(readPurchases(home).length, 1);
  assert.equal(first[0].budget_left, 48);
  // …and the next cycle knows it owns it, from its own receipt and not from asking a shared model
  const second = await watchAgent({ market, patches: ['law-us-2025'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.equal(second[0].actions[0].action, 'owned');
  assert.equal(readPurchases(home).length, 1, 'no second purchase');
  assert.equal((await node.ledger.settlements('law-us-2025')).filter((x) => x.body.buyer === loadIdentity(home).address).length, 1);
  // a track works the same way, and an unknown one is reported rather than thrown away
  const t = await watchAgent({ market, tracks: ['law/KR', 'law/NOPE'], once: true, home, budgetPerDay: 50 }, () => undefined);
  assert.ok(t[0].actions.some((a) => a.patch_id === 'law-kr-2026'));
  assert.ok(t[0].actions.some((a) => a.patch_id === 'law/NOPE' && a.action === 'unavailable'));
  await assert.rejects(watchAgent({ market, once: true, home }, () => undefined), /needs something to watch/);
});

test('agent: a seller\'s refusal is a sentence, not a status code and a JSON blob (items 293, 294)', () => {
  assert.match(sellerError(402, '{"error":"insufficient credit: 2 < 5"}', 'node-a', 'pixel-parent', 'CREDIT'),
    /node-a refused the payment: this agent has 2 CREDIT and pixel-parent costs 5/);
  assert.match(sellerError(402, '{"error":"transfer not found on chain"}', 'node-a', 'p', 'AIN'), /could not confirm the transfer on the chain/);
  assert.match(sellerError(404, '{"error":"this node does not sell that patch"}', 'node-b', 'p', 'AIN'), /node-b does not sell p/);
  assert.match(sellerError(409, '{"error":"nonce already used"}', 'node-b', 'p', 'AIN'), /rejected the payment proof/);
  assert.match(sellerError(500, 'boom', 'node-b', 'p', 'AIN'), /node-b refused the payment \(HTTP 500\): boom/);
});

test('agent: a supersede mark does not retarget the money at 250x the price (items 232, 291)', () => {
  const mk = (id: string, price: string, status: string, supersededBy: string[] = []) => ({
    anchor: { id, price, currency: 'CREDIT', rows: 10, created_at: 1, author: '0xa', author_name: 'a', name: id, description: '', benchmark: { schema: 's' }, topic_path: 't' },
    status, superseded_by: supersededBy, downloads: 0, passed: 1, quorum: 1, quorum_ok: true, sellable: true, attestations: [],
  }) as never;
  const cheap = mk('pixelplus-087600', '0.1', 'SUPERSEDED', ['krx-all-2761']);
  const dear = mk('krx-all-2761', '25', 'LISTED');
  const items = [cheap, dear];
  const said: string[] = [];
  // default: the budget is the price of the item that was asked for → no switch, and the refusal names both prices
  const kept = pickPatch(items, '', 'pixelplus-087600', (l) => said.push(l));
  assert.equal(kept?.anchor.id, 'pixelplus-087600');
  assert.ok(said.some((l) => l.includes('0.1 → 25 CREDIT') && /NOT switching/.test(l)), said.join('\n'));
  // …and the caller who asks for the newer one at any price gets it
  const moved = pickPatch(items, '', 'pixelplus-087600', undefined, { followPrice: 'any' });
  assert.equal(moved?.anchor.id, 'krx-all-2761');
  // …and --no-follow-latest buys exactly what was named
  assert.equal(pickPatch(items, '', 'pixelplus-087600', undefined, { followLatest: false })?.anchor.id, 'pixelplus-087600');
});

test('agent balance derives the initial credit from /api/info instead of assuming 100', async () => {
  const market = `http://127.0.0.1:${port}`;
  const initial = await fetchInitialCredit(market);
  assert.equal(initial, Number(node.cfg.market.initialCredit));
  const fresh = loadIdentity(join(tmp, 'agent-fresh'));
  assert.equal(await creditBalance(market, fresh.address), initial);          // no purchases yet → the node's grant
  assert.equal(await creditBalance(market, fresh.address, 7), 7);             // explicit override still honoured
});
