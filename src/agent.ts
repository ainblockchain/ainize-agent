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
  /**
   * Follow supersede marks to the newest version of what was asked for (item 266). On by default now: yesterday's
   * script kept buying the retired bake of a daily track with only a note in the log, because this was off whenever
   * an explicit `--patch` was given. `followPrice` bounds it — see below.
   */
  followLatest?: boolean;
  /**
   * How much more the newer version may cost (item 291). `same-price` (the default) refuses to switch to a version
   * that costs more than the item that was asked for, unless `--max-price` allows it: pixelplus-087600 is 0.1 AIN
   * and is superseded by a 25 AIN knowledge, and an unattended agent told to "stay current" used to pay the 25.
   * `any` follows regardless, still bounded by `--max-price` when one is given.
   */
  followPrice?: 'same-price' | 'any';
  market: string;
  question?: string;
  expect?: string;
  prompt?: string;
  api?: string;
  patch?: string;
  /** buy the newest LISTED knowledge of this track instead of naming an id (item 266) */
  track?: string;
  repo?: string;
  keep?: boolean;
  home?: string;
  privateKey?: string;
  ainProvider?: string;
  pay?: 'auto' | 'local-credit' | 'ain-transfer';
  maxTokens?: number;
  /** pay again for a knowledge this agent has a receipt for (item 231) — off, so a cron loop cannot re-buy */
  repay?: boolean;
  /** a run that only has to end with the body on disk: "downloaded, not loaded" is then a success (item 284) */
  downloadOnly?: boolean;
  /** the caller filled in the built-in demo question because nothing was asked for — said out loud (item 233) */
  demo?: boolean;
  /**
   * Never ask the model whether it already knows the answer (item 287). `watch` decides what to buy from the
   * purchase record, because the shared model's answer belongs to whoever else has something loaded on it.
   */
  noProbe?: boolean;
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
  /**
   * What actually happened (item 284). `success: true` used to be set on every branch that skipped the apply — no
   * runtime, no hook, no `--repo` — so automation keyed on the exit code believed the knowledge was live in the
   * model when it was only a file on disk.
   *   already_known  the model answered correctly; nothing was bought           exit 0
   *   loaded         bought (or already owned) and loaded into the model        exit 0
   *   downloaded     bought, NOT loaded (no runtime here)                       exit 3, or 0 with --download-only
   *   wrong_answer   loaded, and the model still does not answer as expected    exit 1
   */
  outcome?: 'already_known' | 'loaded' | 'downloaded' | 'wrong_answer';
  /** Set when this run paid nothing because `<home>/purchases.jsonl` already had a receipt for it (item 231). */
  owned?: boolean;
  /** The seller this run paid (or had already paid), by address (item 289). */
  seller?: string | null;
}

/** The exit code for a finished run (item 284): only a knowledge that is LOADED, or a download that was asked for, is 0. */
export function exitCodeFor(res: AgentResult, downloadOnly = false): number {
  if (res.outcome === 'already_known' || res.outcome === 'loaded') return 0;
  if (res.outcome === 'downloaded') return downloadOnly ? 0 : 3;
  return 1;
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

/** What one completion cost and how long it took — the OpenAI-compatible answer carries `usage`, and it used to be thrown away. */
export interface ModelUsage { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null }
export interface ModelAnswer { text: string; model: string; usage: ModelUsage; elapsed_ms: number }

/**
 * One completion, with what it cost (design §9). `ask` prices recall in tokens and milliseconds so that N\* — the
 * break-even between retrieving a fact every time and compiling it once — is computed from measurements instead of
 * from a constant somebody picked. `askModel` below keeps its exact signature and return type: this is the same
 * call, reporting what it already knew.
 */
export async function askModelDetailed(api: string, prompt: string, maxTokens = 8): Promise<ModelAnswer> {
  const started = Date.now();
  const models = await getJson<{ data?: { id: string }[] }>(`${api}/v1/models`, {}, 5000);
  const model = models.body?.data?.[0]?.id;
  if (!model) throw new Error(`no model at ${api}`);
  const r = await getJson<{ choices?: { text: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }>(`${api}/v1/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, max_tokens: maxTokens, temperature: 0 }),
  }, 120_000);
  if (r.status !== 200) throw new Error(`completion failed: ${r.status}`);
  const u = r.body?.usage;
  return {
    text: (r.body?.choices?.[0]?.text ?? '').trim(),
    model,
    // Never invented: a server that does not report `usage` leaves nulls, and the token term of N* is then missing
    // rather than zero — which is what makes `memory --why` able to name what it is short of.
    usage: {
      prompt_tokens: typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : null,
      completion_tokens: typeof u?.completion_tokens === 'number' ? u.completion_tokens : null,
      total_tokens: typeof u?.total_tokens === 'number' ? u.total_tokens : null,
    },
    elapsed_ms: Date.now() - started,
  };
}

export async function askModel(api: string, prompt: string, maxTokens = 8): Promise<string> {
  return (await askModelDetailed(api, prompt, maxTokens)).text;
}

export async function fetchCatalog(market: string, status = 'LISTED,SUPERSEDED'): Promise<CatalogEntry[]> {
  const r = await getJson<{ items: CatalogEntry[] }>(`${market}/api/catalog?status=${encodeURIComponent(status)}&limit=200&sort=popular`);
  if (r.status !== 200) throw new Error(`catalog request failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.body?.items ?? [];
}

/** How far a supersede mark may be followed, and at what price (items 232, 266, 291). */
export interface FollowOptions {
  /** follow supersede marks at all (default true) */
  followLatest?: boolean;
  /** `same-price`: never switch to a version dearer than the one asked for; `any`: switch whatever it costs */
  followPrice?: 'same-price' | 'any';
  /** the hard budget, when the caller set one */
  maxPrice?: number;
}

/**
 * Follow supersede marks (patent fig. 16) to the newest LISTED patch — with the price on the line (items 232, 291).
 *
 * The switch used to be silent about money: `pixelplus-087600 is superseded by krx-all-2761 (newer patch on the
 * same benchmark) → switching` retargeted a 0.1 AIN purchase at a 25 AIN one, 250× the price, decided by a supersede
 * record the buyer never saw, and only an explicit `--max-price` stopped it. The budget is the price of the item
 * that was actually asked for unless the caller raised it, and a switch that would cost more than that is refused
 * out loud — the agent then buys what it was asked for.
 */
export function resolveSupersedes(items: CatalogEntry[], start: CatalogEntry, log?: (l: string) => void, opts: FollowOptions = {}): CatalogEntry {
  if (opts.followLatest === false) return start;
  const asked = Number(start.anchor.price || 0);
  const ceiling = opts.maxPrice !== undefined ? opts.maxPrice : opts.followPrice === 'any' ? Infinity : asked;
  let cur = start;
  const seen = new Set<string>();
  while (cur.status === 'SUPERSEDED' && cur.superseded_by.length && !seen.has(cur.anchor.id)) {
    seen.add(cur.anchor.id);
    const next = cur.superseded_by.map((id) => items.find((e) => e.anchor.id === id)).filter((e): e is CatalogEntry => !!e)
      .sort((a, b) => (b.status === 'LISTED' ? 1 : 0) - (a.status === 'LISTED' ? 1 : 0) || b.anchor.created_at - a.anchor.created_at)[0];
    if (!next) break;
    const price = Number(next.anchor.price || 0);
    const money = `${cur.anchor.price} → ${next.anchor.price} ${next.anchor.currency}`;
    if (price > ceiling + 1e-9) {
      log?.(`    ${cur.anchor.id} has a newer version, ${next.anchor.id} (${money}) — NOT switching: it costs more than ${opts.maxPrice !== undefined ? `--max-price ${opts.maxPrice}` : `the ${cur.anchor.price} ${cur.anchor.currency} item that was asked for`}.`);
      log?.(`    buying ${cur.anchor.id} as asked (--follow-price any, or --max-price ${next.anchor.price}, takes the newer one)`);
      break;
    }
    log?.(`    ${cur.anchor.id} is superseded by ${next.anchor.id} — ${money}, ${next.anchor.rows.toLocaleString('en-US')} rows by ${next.anchor.author_name ?? next.anchor.author.slice(0, 10)} → switching`);
    cur = next;
  }
  return cur;
}

/**
 * Keyword match of the question against name/description/schema/id; ties broken by downloads then attestations.
 *
 * Item 232: when the match is superseded, BOTH candidates are printed with their price and size before one of them
 * is chosen — the developer could not see the choice at all, and `agent catalog` (LISTED only) did not list the
 * cheaper item either.
 */
/**
 * Does `word` occur in `hay` as a WORD, rather than anywhere inside one?
 *
 * `hay.includes(word)` was the whole test, and it spends money: measured 2026-09-07 against a throwaway market,
 * "send me the contract address of the lease we signed last April" bought `pixelplus-demo` for 0.5 CREDIT — because
 * "me" is inside "pixelplus-de**mo**". A two-letter fragment of an id is not a reason to buy anything, and the
 * agent had a receipt for a Korean ticker table in answer to a question about a lease.
 *
 * The boundary is any character that is not a letter or a digit in ANY script, so `krx` still matches
 * "krx-all-2761" and `종목코드` still matches a Korean name — a `\b` would not, since JavaScript's `\w` is ASCII.
 * Punctuation-only and empty words never match.
 */
export function matchesAsWord(hay: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(hay); }
  catch { return hay.includes(word); }   // a word that will not compile: fall back rather than refuse to match at all
}

export function pickPatch(items: CatalogEntry[], question: string, explicit?: string, log?: (l: string) => void, follow: FollowOptions | boolean = {}): CatalogEntry | null {
  const opts: FollowOptions = typeof follow === 'boolean' ? { followLatest: follow } : follow;
  const announce = (e: CatalogEntry) => log?.(`    match: ${e.anchor.id} — ${e.anchor.price} ${e.anchor.currency} · ${e.anchor.rows.toLocaleString('en-US')} rows · ${e.status}${e.superseded_by.length ? ` · newer: ${e.superseded_by.join(', ')}` : ''}`);
  if (explicit) {
    const e = items.find((x) => x.anchor.id === explicit);
    if (!e) return null;
    announce(e);
    return resolveSupersedes(items, e, log, opts);
  }
  const words = question.toLowerCase().split(/[\s,.?!:;()/]+/).filter((w) => w.length >= 2);
  let best: CatalogEntry | null = null; let bestScore = 0;
  for (const e of items) {
    if (e.status !== 'LISTED' && e.status !== 'SUPERSEDED') continue;
    const hay = [e.anchor.id, e.anchor.name, e.anchor.description, e.anchor.benchmark.schema, e.anchor.topic_path].join(' ').toLowerCase();
    let score = 0;
    for (const w of words) if (matchesAsWord(hay, w)) score += w.length;
    if (score > bestScore || (score === bestScore && best && (e.downloads > best.downloads || (e.downloads === best.downloads && e.passed > best.passed)))) { best = e; bestScore = score; }
  }
  if (!(bestScore > 0 && best)) return null;
  announce(best);
  return resolveSupersedes(items, best, log, opts);
}

/**
 * The newest LISTED knowledge on a track (item 266): `--track daily/krx` instead of an id that goes stale overnight.
 * A member retired by another member of the same track is history, exactly as a subscribing node resolves it.
 */
export async function newestOnTrack(market: string, track: string, items: CatalogEntry[]): Promise<CatalogEntry> {
  const r = await getJson<{ branches: { name: string; patch_ids: string[]; current?: string[] }[] }>(`${market}/api/branches`);
  const b = r.body?.branches?.find((x) => x.name === track);
  if (!b) throw new Error(`no track called ${track} on ${market} (GET /api/branches lists them)`);
  const members = new Set(b.patch_ids);
  const usable = (b.current?.length ? b.current : b.patch_ids)
    .map((id) => items.find((e) => e.anchor.id === id))
    .filter((e): e is CatalogEntry => !!e && e.status === 'LISTED' && e.sellable !== false && !e.superseded_by.some((x) => members.has(x)))
    .sort((x, y) => y.anchor.created_at - x.anchor.created_at);
  if (!usable.length) throw new Error(`track ${track} has ${b.patch_ids.length} item(s) and none of them is verified and on sale right now — nothing to buy`);
  return usable[0];
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

/**
 * A settled purchase, written to `<home>/purchases.jsonl` (items 231, 286, 289).
 *
 * The agent used to keep nothing at all: it wrote `identity.json` and `patches/<sha>.npz`, and every run started by
 * asking the gateway, which always answers 402, which it always paid. A cron'd `agent run` was therefore a
 * subscription to the seller's price — three mornings, three purchases of the same bake — and the only record of
 * any of it was in the SELLER's ledger, which a buyer with many sellers cannot scrape. `recordAccess` (the
 * on-chain access receipt) is written by `market.buy` and not by this agent, so this file is the buyer's receipt.
 */
export interface PurchaseRecord {
  patch_id: string; sha256: string; seller: string; seller_name: string | null; gateway: string; market: string;
  amount: string; asset: string; scheme: string; tx_hash: string; nonce: string; path: string; at: number;
}

export function purchasesFile(home: string): string { return join(home, 'purchases.jsonl'); }

/** Everything this agent has bought, oldest first. */
export function readPurchases(home: string): PurchaseRecord[] {
  const f = purchasesFile(home);
  if (!existsSync(f)) return [];
  const out: PurchaseRecord[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as PurchaseRecord); } catch { /* a half-written line is not a purchase */ }
  }
  return out;
}

export function appendPurchase(home: string, row: PurchaseRecord): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(purchasesFile(home), JSON.stringify(row) + '\n', { mode: 0o600 });
}

/** The receipt for a knowledge this agent already owns — matched on the BODY hash, not on the id (a re-publish under a new id of the same bytes is the same purchase). */
export function findPurchase(home: string, patchId: string, sha256: string): PurchaseRecord | undefined {
  return readPurchases(home).find((p) => p.sha256 === sha256 || p.patch_id === patchId);
}

/** What this agent has spent since midnight UTC, per currency — the budget `watch` is held to. */
export function spentToday(home: string, now = Date.now()): Record<string, number> {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const out: Record<string, number> = {};
  for (const p of readPurchases(home)) {
    if (p.at < start.getTime()) continue;
    out[p.asset] = Math.round(((out[p.asset] ?? 0) + Number(p.amount || 0)) * 1e6) / 1e6;
  }
  return out;
}

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

/** Is this AIN provider a development chain on this machine? (`ainize chain fund` works only there — item 285.) */
export function isLocalProvider(url: string): boolean {
  try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'; } catch { return false; }
}

/**
 * Item 290 — the one safety flag this agent offers did not bound the transfer it actually makes.
 *
 * `--max-price` was compared with the CATALOGUE price and then `payFor` transferred `Number(maxAmountRequired)` from
 * the 402, to whatever address the 402 named. The gateway is a separate HTTP endpoint run by the seller, so the
 * quote and the record can differ — and a payment to anyone but the anchor's author buys nothing at all.
 */
export function checkRequirement(req: X402Requirement, pick: CatalogEntry, gateway: string, maxPrice?: number): void {
  const asked = Number(req.maxAmountRequired);
  const onRecord = Number(pick.anchor.price || 0);
  if (!Number.isFinite(asked)) throw new Error(`the seller's 402 asks for ${JSON.stringify(req.maxAmountRequired)}, which is not an amount — refusing to pay`);
  if (asked > onRecord + 1e-9) {
    throw new Error(`the gateway at ${gateway} asks for ${asked} ${req.asset} and the on-ledger record of ${pick.anchor.id} says ${pick.anchor.price} ${pick.anchor.currency} — refusing to pay more than the record. Nothing was paid.`);
  }
  if (maxPrice !== undefined && asked > maxPrice + 1e-9) {
    throw new Error(`the gateway asks for ${asked} ${req.asset}, over --max-price ${maxPrice} — refusing to pay. Nothing was paid.`);
  }
  if (req.payTo.toLowerCase() !== pick.anchor.author.toLowerCase()) {
    throw new Error(`the gateway at ${gateway} asks this agent to pay ${req.payTo}, and ${pick.anchor.id} is published by ${pick.anchor.author} — refusing: a payment to anyone but the anchor's author buys nothing. Nothing was paid.`);
  }
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
      // Item 285: `ngram chain fund` is a dead end on any real network — the command only works against a local dev
      // chain, and the binary is `ainize`. Say which of the two situations this is.
      if (bal < Number(req.maxAmountRequired)) {
        const provider = opts.ainProvider ?? 'http://localhost:8081';
        const how = isLocalProvider(provider)
          ? `fund it on this local chain: ainize chain fund ${identity.address}`
          : `send AIN to ${identity.address} on the network at ${provider}`;
        throw new Error(`agent ${identity.address} holds ${bal} AIN and the price is ${req.maxAmountRequired} — ${how}`);
      }
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
  const res: AgentResult = { identity: identity.address, before: null, after: null, already_known: false, patch_id: null, scheme: null, tx_hash: null, amount: null, sha256: null, path: null, applied: false, restored: false, success: false, steps: [] };
  const step = (s: string) => { res.steps.push(s); log(s); };

  step(`[0] agent ${identity.address}  market ${market}`);
  step(`    serving API ${api || '(none — the market node reports no runtime and no --api was given)'} ${api ? `(${resolved.source})` : ''}`.trimEnd());
  // A payment this agent made and never redeemed is finished FIRST: it has already cost money (item 274).
  const owed = readPending(home);
  if (owed.length) step(`    ${owed.length} payment(s) made by an earlier run were never answered with a manifest: ${owed.map((x) => `${x.patch_id} ${x.amount} ${x.asset} tx ${x.tx_hash.slice(0, 12)}…`).join('; ')}`);

  /*
   * What this run is about. `--track` names a channel instead of an id that goes stale overnight (item 266), and
   * with an explicit knowledge and no `--prompt`/`--expect` the check comes from THAT knowledge's own published
   * benchmark (item 233) — the defaults used to be the Pixelplus demo's question, prompt and expected value, so
   * `run --patch krx-all-2761` measured a knowledge about 2,761 tickers against one fact from another one and
   * declared FAILED, or bought nothing at all because the shared model already answered the demo.
   */
  const catalog = await fetchCatalog(market);
  let target = o.patch;
  if (o.track) {
    const t = await newestOnTrack(market, o.track, catalog);
    target = t.anchor.id;
    step(`[0] track ${o.track} → its newest verified knowledge is ${t.anchor.id} (${t.anchor.price} ${t.anchor.currency}, published ${new Date(t.anchor.created_at).toISOString().slice(0, 10)})`);
  }
  let question = o.question ?? '';
  let prompt = o.prompt ?? question;
  let expect = o.expect ?? '';
  let fromBenchmark: string | null = null;
  if (target && (!o.prompt || !o.expect)) {
    const anchor = (catalog.find((e) => e.anchor.id === target)
      ?? (await getJson<CatalogEntry>(`${market}/api/patches/${encodeURIComponent(target)}`)).body)?.anchor;
    const samples = anchor?.benchmark.samples ?? [];
    if (samples.length) {
      prompt = o.prompt ?? samples[0].prompt;
      expect = o.expect ?? samples[0].expect;
      if (!question) question = samples[0].prompt;
      fromBenchmark = `${target}'s own benchmark (sample 1 of ${samples.length})`;
    }
  }

  // [1] knowledge check
  step(`[1] prompt: ${JSON.stringify(prompt)}${expect ? ` → expects ${JSON.stringify(expect)}` : ' (no expected value given — nothing will be scored)'}`);
  if (fromBenchmark) step(`    taken from ${fromBenchmark}; --prompt / --expect measure something else`);
  else if (o.demo) step('    the built-in Pixelplus demo — no --question, --patch or --track was given');
  let modelOk = false;
  try {
    if (o.noProbe) throw new Error('not asking the shared model: what it answers depends on what other tenants have loaded (--no-probe)');
    if (!api) throw new Error('no serving API: the market node reports none and --api was not given');
    if (!prompt.trim()) throw new Error('nothing to ask: pass --question, --prompt, or a --patch that publishes a benchmark sample');
    res.before = await askModel(api, prompt, o.maxTokens ?? 8);
    modelOk = true;
    const hit = !!expect && res.before.startsWith(expect);
    step(`    current answer: ${JSON.stringify(res.before)}  → ${hit ? 'correct — nothing to buy' : 'wrong/unknown — knowledge purchase needed'}`);
    if (hit) { res.already_known = true; res.outcome = 'already_known'; res.success = true; return res; }
  } catch (e) {
    step(`    serving API unreachable (${(e as Error).message}) — skipping the knowledge check`);
  }

  // [2] catalog
  step('[2] searching the catalog (ledger anchors + verification quorum)');
  const items = catalog;
  // An explicitly requested id may be hidden from the public listing (visibility: test) — resolve it directly, it is still a verified on-ledger anchor.
  if (target && !items.some((e) => e.anchor.id === target)) {
    const direct = await getJson<CatalogEntry>(`${market}/api/patches/${encodeURIComponent(target)}`);
    if (direct.status === 200 && direct.body?.anchor?.id === target) items.push(direct.body);
  }
  const pick = pickPatch(items, question || prompt, target, log, { followLatest: o.followLatest !== false, followPrice: o.followPrice ?? 'same-price', maxPrice: o.maxPrice });
  if (!pick) throw new Error(target ? `patch ${target} is not listed on ${market}` : `no listed patch matches "${question}"`);
  // SUPERSEDED knowledge is still verified and valid (a newer version exists on the same subject) — allowed when explicitly requested.
  if (pick.status === 'SUPERSEDED' && pick.superseded_by?.length) step(`    note: ${pick.anchor.id} has a newer version on the same subject → ${pick.superseded_by.join(', ')} (--follow-price any raises the budget to take it)`);
  if (pick.status !== 'LISTED' && pick.status !== 'SUPERSEDED') throw new Error(`patch ${pick.anchor.id} is ${pick.status}, not verified — refusing to buy`);
  if (!pick.quorum_ok) throw new Error(`verification quorum not met for ${pick.anchor.id} (${pick.passed}/${pick.quorum}) — refusing to buy`);
  // `sellable` is false while a verifier's challenge is open: quorum alone is not permission to spend (item 153).
  if (pick.sellable === false) throw new Error(`${pick.anchor.id} is challenged by a verifier and not for sale until it is re-verified${pick.open_challenge ? `: "${pick.open_challenge.reason}"` : ''} — refusing to buy`);
  if (o.maxPrice !== undefined && Number(pick.anchor.price) > o.maxPrice) throw new Error(`price ${pick.anchor.price} ${pick.anchor.currency} exceeds --max-price ${o.maxPrice} — refusing to buy (use --max-price to raise the budget)`);
  res.patch_id = pick.anchor.id;
  res.seller = pick.anchor.author;
  step(`    candidate: ${pick.anchor.id}  ${(pick.anchor.size_bytes / 1e6).toFixed(1)} MB  ${pick.anchor.rows} rows  price ${pick.anchor.price} ${pick.anchor.currency}  quorum met by ${pick.passed} verifier(s) (${pick.attestations.map((a) => a.verified_on).join(', ')})`);

  /*
   * Item 231 — this agent has bought this knowledge before.
   *
   * Every run used to GET the gateway, which always answers 402 to a buyer it does not recognise, and pay it: a
   * cron'd `agent run` was a standing order at the seller's price (100 → 75 → 50 CREDIT for two runs of the same
   * command), and the "body already present — download skipped" line was printed AFTER the money had moved. The
   * receipt in `<home>/purchases.jsonl` is checked before the gateway is touched.
   */
  const dir = join(home, 'patches');
  const owning = o.repay ? undefined : findPurchase(home, pick.anchor.id, pick.anchor.patch_sha256);
  const ownedPath = owning?.path && existsSync(owning.path) ? owning.path : join(dir, `${pick.anchor.patch_sha256}.npz`);
  let manifestText: string;
  let manifest: PatchManifest;
  let contentSha: string | null;
  let gateway = '';
  if (owning && existsSync(ownedPath)) {
    step(`[3] already bought on ${new Date(owning.at).toISOString()} for ${owning.amount} ${owning.asset} (tx ${owning.tx_hash.slice(0, 14)}…) — not paying again; the receipt is in ${purchasesFile(home)}`);
    step(`    seller ${owning.seller_name ?? owning.seller} · body ${ownedPath}  (--repay buys another copy on purpose)`);
    res.owned = true;
    res.scheme = owning.scheme; res.amount = owning.amount; res.tx_hash = owning.tx_hash; res.seller = owning.seller;
    // The manifest a paid run would have received, rebuilt from the anchor: nothing here is a claim the seller made
    // today — the only fields used below are the hash, the size and (empty) download sources.
    manifest = {
      id: pick.anchor.id, patch_sha256: owning.sha256, size_bytes: pick.anchor.size_bytes, rows: pick.anchor.rows,
      model: pick.anchor.model, benchmark_hash: pick.anchor.benchmark_hash, blob_urls: [],
      issued_to: identity.address, issued_at: owning.at, download_token: '',
    };
    manifestText = '';
    contentSha = null;
  } else {
  // [3] 402
  // `gateway_url` is frozen into an immutable anchor, so a seller that changed its port keeps a listing that looks
  // open and cannot be entered (item 275). The market node knows where that address answers TODAY, so the peers it
  // reports come first and the field on the record is the hint it is; candidates are tried until one answers.
  const candidates = await gatewaysFor(market, pick);
  let r1: { status: number; headers: Headers; body: { requirements?: X402Requirement[] } | null; text: string } | null = null;
  gateway = candidates[0]?.url ?? `${market}/x402/patch/${pick.anchor.id}`;
  const unreachable: string[] = [];
  for (const cand of candidates) {
    step(`[3] requesting the resource → GET ${cand.url}  (${cand.source})`);
    try { r1 = await getJson<{ requirements?: X402Requirement[] }>(cand.url, { headers: { 'x-ngram-buyer': identity.address } }); gateway = cand.url; break; }
    catch (e) { unreachable.push(`${cand.url} (${(e as Error).message})`); step(`    no answer from ${cand.url}: ${(e as Error).message}`); }
  }
  if (!r1) throw new Error(`the seller of ${pick.anchor.id} could not be reached: ${unreachable.join('; ')}`);
  if (r1.status === 402) {
    const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), r1.body ?? undefined);
    const want = o.pay && o.pay !== 'auto' ? o.pay : undefined;
    const req = reqs.find((q) => (want ? q.scheme === want : q.scheme === 'local-credit')) ?? reqs.find((q) => !want) ?? null;
    if (!req) throw new Error(`402 without a usable payment requirement (offered: ${reqs.map((q) => q.scheme).join(',') || 'none'})`);
    step(`    402 Payment Required: ${req.maxAmountRequired} ${req.asset} → ${req.payTo}  (${req.scheme}, nonce ${req.nonce})`);
    // Item 290 — what the 402 actually asks for, checked against the record before any money moves.
    checkRequirement(req, pick, gateway, o.maxPrice);
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
      // Items 293 / 294 — the seller's refusal is a readable sentence on its side and arrived here as a status code
      // and a JSON blob, with no step of its own in the timeline: three "pay: …" lines and no "rejected" anywhere.
      const why = sellerError(r2.status, r2.text, pick.anchor.author_name ?? pick.anchor.author.slice(0, 10), pick.anchor.id, req.asset);
      step(`    REJECTED by the seller: ${why}`);
      throw new Error(`${why} — the payment (${req.maxAmountRequired} ${req.asset}, tx ${payload.txHash.slice(0, 14)}…) is recorded in ${pendingFile(home)}; the next run presents it again instead of paying`);
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
  }

  // [5] verify manifest + download
  if (manifestText) {
    const mSha = sha256Hex(manifestText);
    if (contentSha && contentSha !== mSha) throw new Error(`manifest hash mismatch: header ${contentSha} vs computed ${mSha}`);
    if (manifest.patch_sha256 !== pick.anchor.patch_sha256) throw new Error('manifest sha256 differs from the on-ledger anchor');
    step(`[5] manifest sha256 ${mSha.slice(0, 16)}… matches · body sha256 ${manifest.patch_sha256.slice(0, 16)}… (same as the on-ledger anchor)`);
  }
  mkdirSync(dir, { recursive: true });
  const dest = owning && existsSync(ownedPath) ? ownedPath : join(dir, `${manifest.patch_sha256}.npz`);
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
  } else step(`    body already on this machine — download skipped (${dest})`);
  const got = await sha256File(dest);
  if (got !== manifest.patch_sha256) throw new Error(`sha256 mismatch after download: ${got}`);
  res.sha256 = got; res.path = dest;
  step('    sha256 == on-ledger anchor hash — integrity holds no matter which peer served it');
  // The receipt this agent can read back: what was bought, from whom, for how much, and where the file is (items 231, 286, 289).
  if (!owning && res.tx_hash) {
    appendPurchase(home, {
      patch_id: pick.anchor.id, sha256: got, seller: pick.anchor.author, seller_name: pick.anchor.author_name ?? null,
      gateway, market, amount: res.amount ?? '0', asset: pick.anchor.currency, scheme: res.scheme ?? 'free',
      tx_hash: res.tx_hash, nonce: '', path: dest, at: Date.now(),
    });
    step(`    receipt written to ${purchasesFile(home)} — the next run of this command pays nothing for ${pick.anchor.id}`);
  }

  // [6] runtime apply
  //
  // The model is SHARED (item 230). This step used to run `python3 scripts/patch.py apply|remove` in a default repo
  // with no lock and no record: the node whose model it is never learned, the write raced the node's own writes,
  // and — because `--keep` was false by default — the removal afterwards wrote the model's own rows back over
  // whatever else the operator had loaded. Now: nothing happens without an explicit `--repo`; the same
  // cross-process lock the node takes is held for the whole apply → ask → restore window; the patch is left in
  // place unless the caller asks for it to be removed; and a model that is not the one the knowledge was built for
  // is refused instead of measured.
  //
  // Item 284: none of the branches that SKIP the apply is a success any more. The knowledge is on disk and not in
  // the model, `outcome` says so, and the exit code is 3 unless the caller asked for a download.
  const repo = o.repo;
  const notLoaded = (why: string) => {
    step(`[6] ${why} — ${pick.anchor.id} is downloaded but NOT loaded into any model; body kept at ${dest}`);
    step(`    load it on the node that serves the model:  ainize patch apply ${pick.anchor.id}   (or re-run with --repo <runtime repo>)`);
    res.outcome = 'downloaded';
    res.success = !!o.downloadOnly;
  };
  if (!repo) {
    notLoaded('no --repo: the serving model belongs to the node, and this agent is not its operator');
  } else if (!existsSync(join(repo, 'scripts', 'patch.py'))) {
    notLoaded(`no runtime at ${repo} (scripts/patch.py not found)`);
  } else if (!modelOk) {
    notLoaded('the serving API did not answer, so there is nothing to load into');
  } else {
    let hook = false;
    try { const { stdout } = await execFileP('python3', ['-c', 'from engram import live; print("1" if live.available() else "0")'], { cwd: repo, timeout: 20_000 }); hook = stdout.trim().endsWith('1'); } catch { hook = false; }
    if (!hook) {
      notLoaded('the model is served without the patch hook (start it with ENGRAM_HOOK=1)');
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
        const ok = !!expect && res.after.startsWith(expect);
        step(`    answer with knowledge: ${JSON.stringify(res.after)}  → ${ok ? 'correct' : expect ? 'mismatch' : '(no expected value given)'}`);
        // Default is to LEAVE IT: removing it writes the model's own rows back, which un-teaches whatever the
        // operator had loaded on the same addresses. `--restore` is the explicit opposite.
        if (o.keep === false) {
          const rm = await execFileP('python3', ['scripts/patch.py', 'remove', dest], { cwd: repo, timeout: 10 * 60_000 });
          res.restored = true;
          step(`    restored (--restore): ${rm.stdout.trim()}`);
        } else {
          step(`    left loaded (pass --restore to put the model back; the node's own rows are not touched either way)`);
        }
        res.outcome = !expect || ok ? 'loaded' : 'wrong_answer';
        res.success = !expect || ok;
      } finally { lock(); }
    }
  }
  step(`result: ${res.outcome === 'loaded' ? 'LOADED — bought and live in the model'
    : res.outcome === 'downloaded' ? `DOWNLOADED, NOT LOADED — the body is at ${res.path}${o.downloadOnly ? ' (--download-only)' : ''}`
      : res.outcome === 'wrong_answer' ? 'FAILED — loaded, and the model still does not answer as expected'
        : res.success ? 'SUCCESS' : 'FAILED'}`);
  return res;
}

/**
 * A seller's refusal as a sentence (items 293, 294). The reasons are readable on the seller's side
 * ("insufficient credit", "transfer not found", "this node does not sell that patch") and arrive as a status code
 * and a JSON blob.
 */
export function sellerError(status: number, body: string, seller: string, patchId: string, asset: string): string {
  let detail = (body ?? '').trim();
  try { const j = JSON.parse(detail) as { error?: string; message?: string }; detail = String(j.error ?? j.message ?? detail); } catch { /* the seller answered prose */ }
  detail = detail.slice(0, 300);
  const credit = /insufficient credit:\s*([\d.]+)\s*<\s*([\d.]+)/.exec(detail);
  if (credit) return `${seller} refused the payment: this agent has ${credit[1]} ${asset} and ${patchId} costs ${credit[2]}`;
  if (/transfer (not found|not executed)|no such transfer/i.test(detail)) return `${seller} could not confirm the transfer on the chain (${detail})`;
  if (/does not sell|not for sale|unknown patch/i.test(detail)) return `${seller} does not sell ${patchId} (${detail})`;
  if (/nonce|expired|already used/i.test(detail)) return `${seller} rejected the payment proof: ${detail}`;
  return `${seller} refused the payment (HTTP ${status}): ${detail}`;
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
 * What this agent can actually spend on a market (item 285).
 *
 * `balance` always derived a local-CREDIT figure from settle records and printed "100 CREDIT" against a node whose
 * ledger is `ain` and whose wallet held 196.5 AIN — the wrong number, with confidence, to a developer budgeting a
 * chain of purchases. The node says which ledger it runs at `GET /api/info.ledger.kind`; on `ain` the answer is the
 * chain's own balance for this address, and CREDIT is labelled as the local development credit it is.
 */
export async function agentBalance(market: string, identity: Identity, opts: { ainProvider?: string; initialCredit?: number } = {}): Promise<{
  address: string; kind: string; network: string; currency: string; balance: number | null; note: string; fund: string;
}> {
  const base = market.replace(/\/+$/, '');
  const info = await getJson<{ ledger?: { kind?: string; network?: string }; currency?: string; initial_credit?: string | number; node?: { chain_id?: number } }>(`${base}/api/info`, {}, 10_000);
  if (info.status !== 200 || !info.body) throw new Error(`info request failed: ${info.status} ${info.text.slice(0, 200)}`);
  const kind = info.body.ledger?.kind ?? 'local';
  const network = info.body.ledger?.network ?? 'local';
  if (kind === 'ain') {
    const provider = opts.ainProvider ?? 'http://localhost:8081';
    const ledger = new AinLedger({ providerUrl: provider, chainId: info.body.node?.chain_id ?? 0 }, identity);
    try {
      const bal = await ledger.balance();
      return {
        address: identity.address, kind, network, currency: 'AIN', balance: bal === null || bal === undefined ? null : Number(bal),
        note: `AIN on ${network} (${provider})`,
        fund: isLocalProvider(provider) ? `ainize chain fund ${identity.address}` : `send AIN to ${identity.address} on ${network}`,
      };
    } finally { await ledger.close(); }
  }
  const currency = info.body.currency ?? 'CREDIT';
  const initial = opts.initialCredit ?? Number(info.body.initial_credit ?? 0);
  const bal = await creditBalance(base, identity.address, initial);
  return {
    address: identity.address, kind, network, currency, balance: bal,
    note: `${currency} is local development credit issued by ${base}; it is not AIN and no wallet can spend it elsewhere`,
    fund: `ask the operator of ${base} to grant more ${currency} (it is that node's own book)`,
  };
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

// ---------------------------------------------------------------- `ainize-agent watch` (item 287)
export interface WatchOptions extends Omit<AgentOptions, 'patch' | 'track' | 'question' | 'prompt' | 'expect'> {
  /** knowledge ids to keep current */
  patches?: string[];
  /** tracks whose newest verified knowledge to keep current */
  tracks?: string[];
  /** the most this agent may spend in a day, in the market's currency (spent today is read from purchases.jsonl) */
  budgetPerDay?: number;
  /** seconds between cycles (one cycle only when `once`) */
  intervalS?: number;
  once?: boolean;
}

export interface WatchAction { patch_id: string; action: 'owned' | 'bought' | 'over_budget' | 'failed' | 'loaded' | 'unavailable'; detail: string }
export interface WatchCycle { at: number; actions: WatchAction[]; spent_today: Record<string, number>; budget_left: number | null }

/**
 * "Keep these knowledges loaded and current", as one command (item 287).
 *
 * The agent was one-shot: `run` bought a knowledge, and the only way to stay current was a cron line of `agent run`,
 * which re-asked the shared model (whose answer belongs to whoever else has something loaded), paid again for a
 * body it already held (item 231), and had no notion of a budget. This keeps the buyer's own record — the receipts
 * in `purchases.jsonl` — as the source of truth about what it owns, follows supersede marks under the budget, and
 * never probes the shared model to decide anything.
 */
export async function watchAgent(o: WatchOptions, log: Logger = (l) => process.stdout.write(l + '\n'), stopped: () => boolean = () => false): Promise<WatchCycle[]> {
  const market = o.market.replace(/\/+$/, '');
  const home = agentHome(o.home);
  const identity = loadIdentity(home, o.privateKey);
  const interval = Math.max(10, o.intervalS ?? 300);
  const cycles: WatchCycle[] = [];
  const ids = (o.patches ?? []).filter(Boolean);
  const tracks = (o.tracks ?? []).filter(Boolean);
  if (!ids.length && !tracks.length) throw new Error('watch needs something to watch: --patch <id,…> and/or --track <name,…>');
  log(`agent ${identity.address}  market ${market}`);
  log(`watching ${[...ids.map((x) => `knowledge ${x}`), ...tracks.map((t) => `track ${t}`)].join(', ')} every ${interval}s${o.budgetPerDay !== undefined ? ` · budget ${o.budgetPerDay} a day` : ''}${o.repo ? ` · loading into ${o.repo}` : ' · not loading anything (no --repo)'}`);
  let apiWasDown = false;
  for (;;) {
    const actions: WatchAction[] = [];
    const at = Date.now();
    try {
      const catalog = await fetchCatalog(market);
      const targets: CatalogEntry[] = [];
      for (const t of tracks) {
        try { targets.push(await newestOnTrack(market, t, catalog)); }
        catch (e) { actions.push({ patch_id: t, action: 'unavailable', detail: (e as Error).message }); }
      }
      for (const id of ids) {
        const e = catalog.find((x) => x.anchor.id === id);
        if (!e) { actions.push({ patch_id: id, action: 'unavailable', detail: `not on ${market} right now` }); continue; }
        targets.push(resolveSupersedes(catalog, e, (l) => log(l), { followLatest: o.followLatest !== false, followPrice: o.followPrice ?? 'same-price', maxPrice: o.maxPrice }));
      }
      // The serving model coming back after an outage is the moment a loaded stack has to be put back (a restart
      // drops every live patch). Without `--repo` nothing is loaded by this agent at all, so nothing to put back.
      const apiNow = o.repo ? await servingModel((await resolveApi(market, o.api)).api ?? '').catch(() => null) : null;
      const restarted = !!o.repo && apiWasDown && !!apiNow;
      apiWasDown = !!o.repo && !apiNow;
      if (restarted) log('the serving model answers again after an outage — re-loading the watched knowledge');
      for (const t of targets) {
        const id = t.anchor.id;
        const owned = findPurchase(home, id, t.anchor.patch_sha256);
        const price = Number(t.anchor.price || 0);
        const spent = spentToday(home)[t.anchor.currency] ?? 0;
        if (!owned && o.budgetPerDay !== undefined && spent + price > o.budgetPerDay + 1e-9) {
          actions.push({ patch_id: id, action: 'over_budget', detail: `${price} ${t.anchor.currency} would take today's spend to ${Math.round((spent + price) * 1e6) / 1e6}, over the ${o.budgetPerDay} budget — not bought` });
          continue;
        }
        if (owned && !o.repo) { actions.push({ patch_id: id, action: 'owned', detail: `bought on ${new Date(owned.at).toISOString().slice(0, 10)} for ${owned.amount} ${owned.asset}; body at ${owned.path}` }); continue; }
        if (owned && !restarted) { actions.push({ patch_id: id, action: 'owned', detail: `already bought; ${o.repo ? 'already loaded by an earlier cycle' : 'not loaded'}` }); continue; }
        try {
          const r = await runAgent({ ...o, patch: id, noProbe: true, downloadOnly: !o.repo }, (l) => log('  ' + l));
          actions.push({
            patch_id: id,
            action: r.outcome === 'loaded' ? 'loaded' : owned ? 'owned' : 'bought',
            detail: r.owned ? 'already owned; nothing was paid' : `${r.amount ?? '0'} ${t.anchor.currency} to ${t.anchor.author_name ?? t.anchor.author.slice(0, 10)} (tx ${(r.tx_hash ?? '').slice(0, 14)}…)`,
          });
        } catch (e) {
          actions.push({ patch_id: id, action: 'failed', detail: (e as Error).message });
        }
      }
    } catch (e) {
      actions.push({ patch_id: '-', action: 'failed', detail: (e as Error).message });
    }
    const spent = spentToday(home);
    const cycle: WatchCycle = {
      at, actions, spent_today: spent,
      budget_left: o.budgetPerDay === undefined ? null : Math.round((o.budgetPerDay - Object.values(spent).reduce((a, b) => a + b, 0)) * 1e6) / 1e6,
    };
    cycles.push(cycle);
    for (const a of actions) log(`  ${a.action.padEnd(11)} ${a.patch_id}  ${a.detail}`);
    log(`cycle done ${new Date(at).toISOString()} — spent today ${Object.entries(spent).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}${cycle.budget_left !== null ? ` · ${cycle.budget_left} left of the daily budget` : ''}`);
    if (o.once || stopped()) return cycles;
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (stopped()) return cycles;
  }
}
