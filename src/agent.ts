/**
 * Ainize buyer agent — an AI agent that ainizes its own knowledge gap: (rebuild of the patent prototype's
 * agent_client.py on the node protocol)
 *   [1] detect missing knowledge on the serving model → [2] find a LISTED patch in the catalog (quorum required)
 *   → [3] GET the x402 gateway → 402 → [4] pay (local-credit signed intent or AIN transfer) and retry with X-PAYMENT
 *   → [5] verify manifest hash, download the body, verify sha256 against the on-ledger anchor
 *   → [6] apply to the runtime without restart, re-ask, restore (unless --keep).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  AinLedger, ainPaymentDigest, canonicalJson, decodeRequirements, encodePayload, sha256Hex, signMessage, transferKeyFor,
  X402_HEADER_PAYMENT, X402_HEADER_REQUIRED,
  type CatalogEntry, type Identity, type PatchManifest, type X402Payload, type X402Required, type X402Requirement,
} from '@ngram/core';
import { agentHome, authHeader, loadIdentity } from './identity.js';

const execFileP = promisify(execFile);

export interface AgentOptions {
  /**
   * Refuse purchases above this amount (in the seller's currency). It is a budget for the PURCHASE, not for one
   * item of it: an add-on's bases are counted in (item 270), so `--max-price 60` can no longer pass a 130-CREDIT
   * family.
   */
  maxPrice?: number;
  /** with an explicit patch id: follow supersede marks to the newest version (off by default) */
  followLatest?: boolean;
  market: string;
  question?: string;
  expect?: string;
  prompt?: string;
  api?: string;
  patch?: string;
  repo?: string;
  keep?: boolean;
  home?: string;
  privateKey?: string;
  ainProvider?: string;
  pay?: 'auto' | 'local-credit' | 'ain-transfer';
  maxTokens?: number;
}

export interface AgentResult {
  identity: string;
  before: string | null;
  after: string | null;
  already_known: boolean;
  patch_id: string | null;
  scheme: string | null;
  tx_hash: string | null;
  amount: string | null;
  sha256: string | null;
  path: string | null;
  applied: boolean;
  restored: boolean;
  success: boolean;
  steps: string[];
  /** The bases the bought knowledge needs underneath it, as the seller's 402 declared them (item 270). */
  requires?: X402Required[];
  /** Set when this run finished a payment made by an earlier run instead of paying again (item 274). */
  redeemed?: boolean;
  /** Why the run failed, when it did — set with `--json` so a failure is still a readable result (item 274). */
  error?: string;
}

export type Logger = (line: string) => void;

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; headers: Headers; body: T | null; text: string }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body: T | null = null;
  try { body = text ? (JSON.parse(text) as T) : null; } catch { body = null; }
  return { status: r.status, headers: r.headers, body, text };
}

export async function askModel(api: string, prompt: string, maxTokens = 8): Promise<string> {
  const models = await getJson<{ data?: { id: string }[] }>(`${api}/v1/models`, {}, 5000);
  const model = models.body?.data?.[0]?.id;
  if (!model) throw new Error(`no model at ${api}`);
  const r = await getJson<{ choices?: { text: string }[] }>(`${api}/v1/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, max_tokens: maxTokens, temperature: 0 }),
  }, 120_000);
  if (r.status !== 200) throw new Error(`completion failed: ${r.status}`);
  return (r.body?.choices?.[0]?.text ?? '').trim();
}

export async function fetchCatalog(market: string, status = 'LISTED,SUPERSEDED'): Promise<CatalogEntry[]> {
  const r = await getJson<{ items: CatalogEntry[] }>(`${market}/api/catalog?status=${encodeURIComponent(status)}&limit=200&sort=popular`);
  if (r.status !== 200) throw new Error(`catalog request failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.body?.items ?? [];
}

/** Keyword match of the question against name/description/schema/id; ties broken by downloads then attestations. */
/** Follow supersede marks (patent fig. 16) to the newest LISTED patch. */
export function resolveSupersedes(items: CatalogEntry[], start: CatalogEntry, log?: (l: string) => void): CatalogEntry {
  let cur = start;
  const seen = new Set<string>();
  while (cur.status === 'SUPERSEDED' && cur.superseded_by.length && !seen.has(cur.anchor.id)) {
    seen.add(cur.anchor.id);
    const next = cur.superseded_by.map((id) => items.find((e) => e.anchor.id === id)).filter((e): e is CatalogEntry => !!e)
      .sort((a, b) => (b.status === 'LISTED' ? 1 : 0) - (a.status === 'LISTED' ? 1 : 0) || b.anchor.created_at - a.anchor.created_at)[0];
    if (!next) break;
    log?.(`    ${cur.anchor.id} is superseded by ${next.anchor.id} (newer patch on the same benchmark) → switching`);
    cur = next;
  }
  return cur;
}

export function pickPatch(items: CatalogEntry[], question: string, explicit?: string, log?: (l: string) => void, followLatest = true): CatalogEntry | null {
  if (explicit) {
    const e = items.find((x) => x.anchor.id === explicit);
    if (!e) return null;
    // An explicitly requested id is honoured as-is unless the caller opted into following newer versions.
    return followLatest ? resolveSupersedes(items, e, log) : e;
  }
  const words = question.toLowerCase().split(/[\s,.?!:;()/]+/).filter((w) => w.length >= 2);
  let best: CatalogEntry | null = null; let bestScore = 0;
  for (const e of items) {
    if (e.status !== 'LISTED' && e.status !== 'SUPERSEDED') continue;
    const hay = [e.anchor.id, e.anchor.name, e.anchor.description, e.anchor.benchmark.schema, e.anchor.topic_path].join(' ').toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    if (score > bestScore || (score === bestScore && best && (e.downloads > best.downloads || (e.downloads === best.downloads && e.passed > best.passed)))) { best = e; bestScore = score; }
  }
  return bestScore > 0 && best ? resolveSupersedes(items, best, log) : null;
}

/**
 * One x402 payment this agent has made and not yet redeemed (item 274). Appended to
 * `<home>/pending-payments.jsonl` BEFORE the payload is presented, so a failure between the money and the manifest
 * leaves evidence on this machine and not only on the chain — and the next run re-presents it instead of paying
 * again (the seller answers a payment it has already settled with the same manifest, no second charge).
 */
export interface PendingPayment {
  gateway: string; resource: string; patch_id: string; scheme: string; amount: string; asset: string;
  pay_to: string; nonce: string; tx_hash: string; payload: X402Payload; at: number;
}

export function pendingFile(home: string): string { return join(home, 'pending-payments.jsonl'); }

/** Payments this agent made that were never answered with a manifest, oldest first. */
export function readPending(home: string): PendingPayment[] {
  const f = pendingFile(home);
  if (!existsSync(f)) return [];
  const out: PendingPayment[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as PendingPayment); } catch { /* a half-written line is not a payment */ }
  }
  return out;
}

function writePending(home: string, rows: PendingPayment[]) {
  mkdirSync(home, { recursive: true });
  writeFileSync(pendingFile(home), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
}

/** Record the intent before the money moves. */
export function appendPending(home: string, row: PendingPayment) {
  mkdirSync(home, { recursive: true });
  appendFileSync(pendingFile(home), JSON.stringify(row) + '\n', { mode: 0o600 });
}

/** Drop a payment that has been redeemed (or that the seller says was already settled). */
export function clearPending(home: string, txHash: string) {
  writePending(home, readPending(home).filter((r) => r.tx_hash !== txHash));
}

/**
 * Where this knowledge is sold right now, best first (item 275): the endpoints the market node currently sees for
 * the anchor's author, the market node itself when it is the author, and — last — the URL frozen into the anchor.
 */
export async function gatewaysFor(market: string, pick: CatalogEntry): Promise<{ url: string; source: string }[]> {
  const id = pick.anchor.id;
  const path = `/x402/patch/${id}`;
  const out: { url: string; source: string }[] = [];
  const push = (base: string | null | undefined, source: string) => {
    if (!base) return;
    const url = base.endsWith(path) ? base : `${base.replace(/\/+$/, '')}${path}`;
    if (!out.some((x) => x.url === url)) out.push({ url, source });
  };
  const r = await getJson<{ nodes?: { address: string; endpoint: string; last_seen?: number }[]; peers?: { endpoint: string; address: string | null; last_seen: number }[]; self?: string }>(`${market}/api/nodes`, {}, 10_000).catch(() => null);
  const peers = (r?.body?.peers ?? []).filter((p) => p.address === pick.anchor.author).sort((a, b) => b.last_seen - a.last_seen);
  for (const p of peers) push(p.endpoint, `${market}/api/nodes, last seen ${p.last_seen ? new Date(p.last_seen).toISOString() : 'never'}`);
  if (r?.body?.self === pick.anchor.author) push(market, 'the market node is the seller');
  for (const n of (r?.body?.nodes ?? []).filter((n) => n.address === pick.anchor.author)) push(n.endpoint, 'node record on the ledger');
  push((pick.anchor as CatalogEntry['anchor'] & { gateway_url?: string }).gateway_url, 'address on the record');
  push(market, 'the market node, as a last resort');
  return out;
}

export async function payFor(req: X402Requirement, identity: Identity, opts: { ainProvider?: string }): Promise<X402Payload> {
  if (req.scheme === 'local-credit') {
    const h = sha256Hex(canonicalJson({ resource: req.resource, amount: req.maxAmountRequired, nonce: req.nonce, payTo: req.payTo, from: identity.address }));
    return { scheme: 'local-credit', network: 'local', txHash: h, from: identity.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, proof: signMessage(h, identity.privateKey) };
  }
  if (req.scheme === 'ain-transfer') {
    const ledger = new AinLedger({ providerUrl: opts.ainProvider ?? 'http://localhost:8081', chainId: 0 }, identity);
    try {
      const bal = Number((await ledger.balance()) ?? 0) || 0;   // unknown account → 0 AIN (not null)
      if (bal < Number(req.maxAmountRequired)) throw new Error(`agent ${identity.address} holds ${bal} AIN < price ${req.maxAmountRequired} (fund it: ngram chain fund ${identity.address})`);
      // The transfer carries the key the seller put in the 402, and the payload a signature over (tx, nonce): a
      // transfer that answers no quote buys nothing, and a public tx hash is not a bearer ticket (item 344).
      const key = req.transfer_key ?? transferKeyFor(req.resource, req.nonce);
      const t = await ledger.transfer(req.payTo, Number(req.maxAmountRequired), key);
      return {
        scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: identity.address, to: req.payTo,
        amount: req.maxAmountRequired, nonce: req.nonce, transfer_key: key,
        proof: signMessage(ainPaymentDigest(t.tx_hash, req.nonce), identity.privateKey),
      };
    } finally { await ledger.close(); }
  }
  throw new Error(`unsupported payment scheme ${String((req as { scheme: string }).scheme)}`);
}

/**
 * Which serving API to measure against (item 230).
 *
 * `--api` used to default to ENGRAM_API_PUBLIC ?? localhost:8000 — a different server from the one the market node
 * patches, so the before/after could be measured on a model that never saw the knowledge. The node knows which
 * engine it drives and says so at `GET /api/runtime`; that is the answer unless the caller names one.
 */
export async function resolveApi(market: string, explicit?: string): Promise<{ api: string | null; source: string; model: string | null }> {
  if (explicit) return { api: explicit.replace(/\/+$/, ''), source: '--api', model: null };
  const r = await getJson<{ api?: string | null; model?: string | null }>(`${market}/api/runtime`, {}, 10_000).catch(() => null);
  if (r?.status === 200 && r.body?.api) return { api: String(r.body.api).replace(/\/+$/, ''), source: `${market}/api/runtime`, model: r.body.model ?? null };
  const env = process.env.ENGRAM_API_PUBLIC;
  if (env) return { api: env.replace(/\/+$/, ''), source: 'ENGRAM_API_PUBLIC', model: null };
  return { api: null, source: 'unknown', model: null };
}

export async function runAgent(o: AgentOptions, log: Logger = (l) => process.stdout.write(l + '\n')): Promise<AgentResult> {
  const market = o.market.replace(/\/+$/, '');
  const resolved = await resolveApi(market, o.api);
  const api = resolved.api ?? '';
  const home = agentHome(o.home);
  const identity = loadIdentity(home, o.privateKey);
  const question = o.question ?? '';
  const prompt = o.prompt ?? question;
  const res: AgentResult = { identity: identity.address, before: null, after: null, already_known: false, patch_id: null, scheme: null, tx_hash: null, amount: null, sha256: null, path: null, applied: false, restored: false, success: false, steps: [] };
  const step = (s: string) => { res.steps.push(s); log(s); };

  step(`[0] agent ${identity.address}  market ${market}`);
  step(`    serving API ${api || '(none — the market node reports no runtime and no --api was given)'} ${api ? `(${resolved.source})` : ''}`.trimEnd());
  // A payment this agent made and never redeemed is finished FIRST: it has already cost money (item 274).
  const owed = readPending(home);
  if (owed.length) step(`    ${owed.length} payment(s) made by an earlier run were never answered with a manifest: ${owed.map((x) => `${x.patch_id} ${x.amount} ${x.asset} tx ${x.tx_hash.slice(0, 12)}…`).join('; ')}`);
  // [1] knowledge check
  step(`[1] question: ${JSON.stringify(question || prompt)}`);
  let modelOk = false;
  try {
    if (!api) throw new Error('no serving API: the market node reports none and --api was not given');
    res.before = await askModel(api, prompt, o.maxTokens ?? 8);
    modelOk = true;
    const hit = !!o.expect && res.before.startsWith(o.expect);
    step(`    current answer: ${JSON.stringify(res.before)}  → ${hit ? 'correct — nothing to buy' : 'wrong/unknown — knowledge purchase needed'}`);
    if (hit) { res.already_known = true; res.success = true; return res; }
  } catch (e) {
    step(`    serving API unreachable (${(e as Error).message}) — skipping the knowledge check`);
  }

  // [2] catalog
  step('[2] searching the catalog (ledger anchors + verification quorum)');
  const items = await fetchCatalog(market);
  // An explicitly requested id may be hidden from the public listing (visibility: test) — resolve it directly, it is still a verified on-ledger anchor.
  if (o.patch && !items.some((e) => e.anchor.id === o.patch)) {
    const direct = await getJson<CatalogEntry>(`${market}/api/patches/${encodeURIComponent(o.patch)}`);
    if (direct.status === 200 && direct.body?.anchor?.id === o.patch) items.push(direct.body);
  }
  const pick = pickPatch(items, question || prompt, o.patch, log, o.patch ? !!o.followLatest : true);
  if (!pick) throw new Error(o.patch ? `patch ${o.patch} is not listed on ${market}` : `no listed patch matches "${question}"`);
  // SUPERSEDED knowledge is still verified and valid (a newer version exists on the same subject) — allowed when explicitly requested.
  if (pick.status === 'SUPERSEDED' && pick.superseded_by?.length) step(`    note: ${pick.anchor.id} has a newer version on the same subject → ${pick.superseded_by.join(', ')} (use --follow-latest to switch automatically)`);
  if (pick.status !== 'LISTED' && pick.status !== 'SUPERSEDED') throw new Error(`patch ${pick.anchor.id} is ${pick.status}, not verified — refusing to buy`);
  if (!pick.quorum_ok) throw new Error(`verification quorum not met for ${pick.anchor.id} (${pick.passed}/${pick.quorum}) — refusing to buy`);
  // `sellable` is false while a verifier's challenge is open: quorum alone is not permission to spend (item 153).
  if (pick.sellable === false) throw new Error(`${pick.anchor.id} is challenged by a verifier and not for sale until it is re-verified${pick.open_challenge ? `: "${pick.open_challenge.reason}"` : ''} — refusing to buy`);
  if (o.maxPrice !== undefined && Number(pick.anchor.price) > o.maxPrice) throw new Error(`price ${pick.anchor.price} ${pick.anchor.currency} exceeds --max-price ${o.maxPrice} — refusing to buy (use --max-price to raise the budget)`);
  res.patch_id = pick.anchor.id;
  step(`    candidate: ${pick.anchor.id}  ${(pick.anchor.size_bytes / 1e6).toFixed(1)} MB  ${pick.anchor.rows} rows  price ${pick.anchor.price} ${pick.anchor.currency}  quorum met by ${pick.passed} verifier(s) (${pick.attestations.map((a) => a.verified_on).join(', ')})`);

  // [3] 402
  // `gateway_url` is frozen into an immutable anchor, so a seller that changed its port keeps a listing that looks
  // open and cannot be entered (item 275). The market node knows where that address answers TODAY, so the peers it
  // reports come first and the field on the record is the hint it is; candidates are tried until one answers.
  const candidates = await gatewaysFor(market, pick);
  let r1: { status: number; headers: Headers; body: { requirements?: X402Requirement[] } | null; text: string } | null = null;
  let gateway = candidates[0]?.url ?? `${market}/x402/patch/${pick.anchor.id}`;
  const unreachable: string[] = [];
  for (const cand of candidates) {
    step(`[3] requesting the resource → GET ${cand.url}  (${cand.source})`);
    try { r1 = await getJson<{ requirements?: X402Requirement[] }>(cand.url, { headers: { 'x-ngram-buyer': identity.address } }); gateway = cand.url; break; }
    catch (e) { unreachable.push(`${cand.url} (${(e as Error).message})`); step(`    no answer from ${cand.url}: ${(e as Error).message}`); }
  }
  if (!r1) throw new Error(`the seller of ${pick.anchor.id} could not be reached: ${unreachable.join('; ')}`);
  let manifestText: string;
  let manifest: PatchManifest;
  let contentSha: string | null;
  if (r1.status === 402) {
    const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), r1.body ?? undefined);
    const want = o.pay && o.pay !== 'auto' ? o.pay : undefined;
    const req = reqs.find((q) => (want ? q.scheme === want : q.scheme === 'local-credit')) ?? reqs.find((q) => !want) ?? null;
    if (!req) throw new Error(`402 without a usable payment requirement (offered: ${reqs.map((q) => q.scheme).join(',') || 'none'})`);
    step(`    402 Payment Required: ${req.maxAmountRequired} ${req.asset} → ${req.payTo}  (${req.scheme}, nonce ${req.nonce})`);
    // What the seller says this knowledge needs underneath it, and what the family costs (item 270). The budget is
    // checked against THAT, not against the one item: an add-on whose base costs 100 is not a 3-CREDIT purchase.
    res.requires = req.requires ?? [];
    const total = Number(req.total ?? req.maxAmountRequired);
    if (res.requires.length) {
      step(`    it needs ${res.requires.map((x) => `${x.id}${x.known ? ` (${x.price} ${x.currency})` : ' (price unknown here)'}`).join(' → ')} underneath it — ${total} ${req.asset} for the family, and this agent buys only ${pick.anchor.id}`);
    }
    if (o.maxPrice !== undefined && total > o.maxPrice) {
      throw new Error(`${pick.anchor.id} costs ${total} ${req.asset}${res.requires.length ? ` with the ${res.requires.length} base(s) it needs` : ''} — over --max-price ${o.maxPrice}, refusing to buy. Nothing was paid.`);
    }
    // [4] pay
    // A payment already made for this resource is presented again instead of paying twice (item 274): the seller
    // re-issues the manifest against the settlement it already recorded.
    const already = readPending(home).find((x) => x.resource === req.resource && x.pay_to === req.payTo);
    let payload: X402Payload;
    if (already) {
      step(`[4] a payment for this resource was already made on ${new Date(already.at).toISOString()} (tx ${already.tx_hash.slice(0, 14)}…) — presenting it again instead of paying`);
      payload = already.payload;
      res.redeemed = true;
    } else {
      step(`[4] paying (${req.scheme === 'ain-transfer' ? 'AIN transfer on chain' : 'signed credit intent'}) and retrying with the proof`);
      payload = await payFor(req, identity, { ainProvider: o.ainProvider });
      // Written down BEFORE the payload is presented: from here on the money is gone, and this line is the receipt.
      appendPending(home, {
        gateway, resource: req.resource, patch_id: pick.anchor.id, scheme: payload.scheme, amount: req.maxAmountRequired,
        asset: req.asset, pay_to: req.payTo, nonce: req.nonce, tx_hash: payload.txHash, payload, at: Date.now(),
      });
      step(`    paid tx ${payload.txHash} → ${req.payTo} for ${req.resource} (nonce ${req.nonce}); recorded in ${pendingFile(home)}`);
    }
    res.scheme = payload.scheme; res.amount = req.maxAmountRequired; res.tx_hash = payload.txHash;
    const r2 = await getJson<unknown>(gateway, { headers: { [X402_HEADER_PAYMENT]: encodePayload(payload), 'x-ngram-buyer': identity.address } }, 120_000);
    if (r2.status !== 200) {
      throw new Error(`payment rejected: ${r2.status} ${r2.text.slice(0, 300)} — the payment (${req.maxAmountRequired} ${req.asset}, tx ${payload.txHash.slice(0, 14)}…) is recorded in ${pendingFile(home)}; the next run presents it again instead of paying`);
    }
    manifestText = r2.text;
    manifest = JSON.parse(manifestText) as PatchManifest;
    contentSha = r2.headers.get('x-content-sha256');
    res.tx_hash = r2.headers.get('x-payment-tx-hash') ?? payload.txHash;
    clearPending(home, payload.txHash);
    step(`    settled: tx ${res.tx_hash}  ${r2.headers.get('x-payment-response') ?? ''}`.trimEnd());
  } else if (r1.status === 200) {
    manifestText = r1.text; manifest = JSON.parse(manifestText) as PatchManifest; contentSha = r1.headers.get('x-content-sha256'); res.scheme = 'free';
    step('    free resource — manifest received without payment');
  } else {
    throw new Error(`gateway answered ${r1.status}: ${r1.text.slice(0, 300)}`);
  }

  // [5] verify manifest + download
  const mSha = sha256Hex(manifestText);
  if (contentSha && contentSha !== mSha) throw new Error(`manifest hash mismatch: header ${contentSha} vs computed ${mSha}`);
  if (manifest.patch_sha256 !== pick.anchor.patch_sha256) throw new Error('manifest sha256 differs from the on-ledger anchor');
  step(`[5] manifest sha256 ${mSha.slice(0, 16)}… matches · body sha256 ${manifest.patch_sha256.slice(0, 16)}… (same as the on-ledger anchor)`);
  const dir = join(home, 'patches');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${manifest.patch_sha256}.npz`);
  if (!existsSync(dest)) {
    let lastErr: Error | null = null;
    for (const url of manifest.blob_urls) {
      try {
        const r = await fetch(`${url}?token=${encodeURIComponent(manifest.download_token)}`, { headers: { 'x-ngram-auth': authHeader(identity, `blob:${manifest.patch_sha256}`) }, signal: AbortSignal.timeout(10 * 60_000) });
        if (!r.ok || !r.body) throw new Error(`${url} → ${r.status}`);
        await pipeline(Readable.fromWeb(r.body as never), createWriteStream(`${dest}.part`));
        renameSync(`${dest}.part`, dest);
        step(`    received ${(manifest.size_bytes / 1e6).toFixed(1)} MB from ${url}`);
        lastErr = null; break;
      } catch (e) { lastErr = e as Error; }
    }
    if (lastErr) throw new Error(`download failed: ${lastErr.message}`);
  } else step('    body already present — download skipped');
  const got = await sha256File(dest);
  if (got !== manifest.patch_sha256) throw new Error(`sha256 mismatch after download: ${got}`);
  res.sha256 = got; res.path = dest;
  step('    sha256 == on-ledger anchor hash — integrity holds no matter which peer served it');

  // [6] runtime apply
  //
  // The model is SHARED (item 230). This step used to run `python3 scripts/patch.py apply|remove` in a default repo
  // with no lock and no record: the node whose model it is never learned, the write raced the node's own writes,
  // and — because `--keep` was false by default — the removal afterwards wrote the model's own rows back over
  // whatever else the operator had loaded. Now: nothing happens without an explicit `--repo`; the same
  // cross-process lock the node takes is held for the whole apply → ask → restore window; the patch is left in
  // place unless the caller asks for it to be removed; and a model that is not the one the knowledge was built for
  // is refused instead of measured.
  const repo = o.repo;
  if (!repo) {
    step(`[6] not touching the serving model: it belongs to the node, and this agent is not its operator.`);
    step(`    load it there with:  ainize patch apply ${pick.anchor.id}   (or re-run with --repo <runtime repo> to load it directly, taking the node's lock)`);
    step(`    body kept at ${dest}`);
    res.success = true;
  } else if (!existsSync(join(repo, 'scripts', 'patch.py'))) {
    step(`[6] no runtime at ${repo} (scripts/patch.py not found) — apply step skipped; body kept at ${dest}`);
    res.success = true;
  } else if (!modelOk) {
    step(`[6] the serving API did not answer, so there is nothing to load into — apply step skipped; body kept at ${dest}`);
    res.success = true;
  } else {
    let hook = false;
    try { const { stdout } = await execFileP('python3', ['-c', 'from engram import live; print("1" if live.available() else "0")'], { cwd: repo, timeout: 20_000 }); hook = stdout.trim().endsWith('1'); } catch { hook = false; }
    if (!hook) {
      step('[6] no patch hook (serve with ENGRAM_HOOK=1) — apply step skipped');
      res.success = true;
    } else {
      // The knowledge is trained for one model; loading it into another measures nothing (item 230).
      const serving = await servingModel(api);
      if (serving && !modelsMatch(serving, pick.anchor.model.id_M)) {
        throw new Error(`refusing to load ${pick.anchor.id}: it was trained for ${pick.anchor.model.id_M} and ${api} is serving ${serving}`);
      }
      const lock = await takeRuntimeLock(repo, `agent:${pick.anchor.id}`, (l) => step(l));
      try {
        step('[6] loading into the running model (no restart), holding the shared runtime lock');
        const ap = await execFileP('python3', ['scripts/patch.py', 'apply', dest], { cwd: repo, timeout: 10 * 60_000 });
        step(`    ${ap.stdout.trim()}`);
        res.applied = true;
        res.after = await askModel(api, prompt, o.maxTokens ?? 8);
        const ok = !!o.expect && res.after.startsWith(o.expect);
        step(`    answer with knowledge: ${JSON.stringify(res.after)}  → ${ok ? 'correct' : o.expect ? 'mismatch' : '(no expected value given)'}`);
        // Default is to LEAVE IT: removing it writes the model's own rows back, which un-teaches whatever the
        // operator had loaded on the same addresses. `--restore` is the explicit opposite.
        if (o.keep === false) {
          const rm = await execFileP('python3', ['scripts/patch.py', 'remove', dest], { cwd: repo, timeout: 10 * 60_000 });
          res.restored = true;
          step(`    restored (--restore): ${rm.stdout.trim()}`);
        } else {
          step(`    left loaded (pass --restore to put the model back; the node's own rows are not touched either way)`);
        }
        res.success = !o.expect || ok;
      } finally { lock(); }
    }
  }
  step(`result: ${res.success ? 'SUCCESS — the 402 purchase loop completed' : 'FAILED'}`);
  return res;
}

/** The model id the serving API reports (null when it cannot be asked). */
async function servingModel(api: string): Promise<string | null> {
  const r = await getJson<{ data?: { id: string }[] }>(`${api}/v1/models`, {}, 5000).catch(() => null);
  return r?.body?.data?.[0]?.id ?? null;
}

/** Model ids compare loosely: a served path (`/models/qwen3-8b`) is the same model as the anchor's `qwen3-8b`. */
export function modelsMatch(serving: string, anchor: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? x.toLowerCase();
  return norm(serving) === norm(anchor) || serving.toLowerCase().includes(anchor.toLowerCase()) || anchor.toLowerCase().includes(norm(serving));
}

/**
 * The SAME cross-process lock the node takes (node/src/runtime.ts): an atomic mkdir of
 * `<repo>/ple_patch/.ainize-runtime.lock` holding a `holder.json` lease. Several nodes and this agent share one
 * serving model, and every writer has to queue on the same directory or they overwrite each other's rows.
 * A lease whose `pid:` holder is gone is broken after 15 minutes, exactly as the node breaks it.
 */
async function takeRuntimeLock(repo: string, label: string, log: (l: string) => void, waitMs = 5 * 60_000): Promise<() => void> {
  const dir = join(repo, 'ple_patch', '.ainize-runtime.lock');
  const owner = `pid:${process.pid}`;
  const STALE_MS = 15 * 60_000;
  const t0 = Date.now();
  let told = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'holder.json'), JSON.stringify({ owner, label, since: Date.now() }));
      return () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    } catch {
      type Holder = { owner?: string; label?: string; since?: number };
      let holder: Holder | null = null;
      try { holder = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8')) as Holder; } catch { holder = null; }
      const pid = holder?.owner?.startsWith('pid:') ? Number(holder.owner.slice(4)) : null;
      let alive = true;
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch { alive = false; } }
      if (!holder || !alive || Date.now() - (holder.since ?? 0) > STALE_MS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
      if (!told) { log(`    the shared runtime is busy (${holder.owner}: ${holder.label}) — waiting for the lock instead of writing over it`); told = true; }
      if (Date.now() - t0 > waitMs) throw new Error(`shared runtime busy (${holder.owner}: ${holder.label}) — try again later`);
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
    }
  }
}

/** Market-wide info (GET /api/info): the node's configured initial credit for new buyers, currency, quorum … */
export interface MarketInfo { initial_credit: string | number; currency: string; quorum: number; node: { address: string; name: string; model?: string | null }; counts: { patches: number; listed: number } }

export async function fetchInfo(market: string): Promise<MarketInfo> {
  const r = await getJson<MarketInfo>(`${market.replace(/\/+$/, '')}/api/info`, {}, 10_000);
  if (r.status !== 200 || !r.body) throw new Error(`info request failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.body;
}

/** The node's initial local-credit grant per new address (market.initialCredit, exposed as /api/info.initial_credit). */
export async function fetchInitialCredit(market: string): Promise<number> {
  const info = await fetchInfo(market);
  const n = Number(info.initial_credit);
  if (!Number.isFinite(n)) throw new Error(`node did not report a numeric initial_credit (${JSON.stringify(info.initial_credit)})`);
  return n;
}

/**
 * local-credit balance of an address, derived like Market.creditBalance: initial credit (read from
 * GET /api/info.initial_credit unless given) − purchases + royalties received.
 */
export async function creditBalance(market: string, address: string, initialCredit?: number): Promise<number> {
  const base = market.replace(/\/+$/, '');
  const initial = initialCredit ?? await fetchInitialCredit(base);
  const r = await getJson<{ records: { kind: string; body: { scheme?: string; buyer?: string; amount?: string; royalty?: Record<string, string> } }[] }>(`${base}/api/ledger?kind=settle&limit=1000`);
  let bal = initial;
  for (const rec of r.body?.records ?? []) {
    const s = rec.body;
    if (s.scheme !== 'local-credit') continue;
    if (s.buyer === address) bal -= Number(s.amount ?? 0);
    for (const [addr, amt] of Object.entries(s.royalty ?? {})) if (addr === address) bal += Number(amt);
  }
  return Math.round(bal * 1e6) / 1e6;
}
