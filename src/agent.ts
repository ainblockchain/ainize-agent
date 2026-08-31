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
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  AinLedger, canonicalJson, decodeRequirements, encodePayload, sha256Hex, signMessage, X402_HEADER_PAYMENT, X402_HEADER_REQUIRED,
  type CatalogEntry, type Identity, type PatchManifest, type X402Payload, type X402Requirement,
} from '@ngram/core';
import { agentHome, authHeader, loadIdentity } from './identity.js';

const execFileP = promisify(execFile);

export interface AgentOptions {
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
/** Follow supersede marks (도 16 대체 표시) to the newest LISTED patch. */
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

export function pickPatch(items: CatalogEntry[], question: string, explicit?: string, log?: (l: string) => void): CatalogEntry | null {
  if (explicit) {
    const e = items.find((x) => x.anchor.id === explicit);
    return e ? resolveSupersedes(items, e, log) : null;
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

export async function payFor(req: X402Requirement, identity: Identity, opts: { ainProvider?: string }): Promise<X402Payload> {
  if (req.scheme === 'local-credit') {
    const h = sha256Hex(canonicalJson({ resource: req.resource, amount: req.maxAmountRequired, nonce: req.nonce, payTo: req.payTo, from: identity.address }));
    return { scheme: 'local-credit', network: 'local', txHash: h, from: identity.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, proof: signMessage(h, identity.privateKey) };
  }
  if (req.scheme === 'ain-transfer') {
    const ledger = new AinLedger({ providerUrl: opts.ainProvider ?? 'http://localhost:8081', chainId: 0 }, identity);
    try {
      const bal = await ledger.balance();
      if (bal < Number(req.maxAmountRequired)) throw new Error(`agent ${identity.address} holds ${bal} AIN < price ${req.maxAmountRequired} (fund it: ngram chain fund ${identity.address})`);
      const t = await ledger.transfer(req.payTo, Number(req.maxAmountRequired));
      return { scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: identity.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce };
    } finally { await ledger.close(); }
  }
  throw new Error(`unsupported payment scheme ${String((req as { scheme: string }).scheme)}`);
}

export async function runAgent(o: AgentOptions, log: Logger = (l) => process.stdout.write(l + '\n')): Promise<AgentResult> {
  const market = o.market.replace(/\/+$/, '');
  const api = (o.api ?? 'http://localhost:8000').replace(/\/+$/, '');
  const home = agentHome(o.home);
  const identity = loadIdentity(home, o.privateKey);
  const question = o.question ?? '';
  const prompt = o.prompt ?? question;
  const res: AgentResult = { identity: identity.address, before: null, after: null, already_known: false, patch_id: null, scheme: null, tx_hash: null, amount: null, sha256: null, path: null, applied: false, restored: false, success: false, steps: [] };
  const step = (s: string) => { res.steps.push(s); log(s); };

  step(`[0] agent ${identity.address}  market ${market}`);
  // [1] knowledge check
  step(`[1] 질의: ${JSON.stringify(question || prompt)}`);
  let modelOk = false;
  try {
    res.before = await askModel(api, prompt, o.maxTokens ?? 8);
    modelOk = true;
    const hit = !!o.expect && res.before.startsWith(o.expect);
    step(`    현재 답: ${JSON.stringify(res.before)}  → ${hit ? '정답 — 구매 불필요' : '오답/미지 — 지식 구매 필요'}`);
    if (hit) { res.already_known = true; res.success = true; return res; }
  } catch (e) {
    step(`    serving API unreachable (${(e as Error).message}) — skipping the knowledge check`);
  }

  // [2] catalog
  step('[2] 카탈로그 검색 (원장 anchor + 검증 정족수)');
  const items = await fetchCatalog(market);
  const pick = pickPatch(items, question || prompt, o.patch, log);
  if (!pick) throw new Error(o.patch ? `patch ${o.patch} is not listed on ${market}` : `no listed patch matches "${question}"`);
  if (pick.status !== 'LISTED') throw new Error(`patch ${pick.anchor.id} is ${pick.status}, not LISTED — refusing to buy`);
  if (!pick.quorum_ok) throw new Error(`verification quorum not met for ${pick.anchor.id} (${pick.passed}/${pick.quorum}) — 구매 거부`);
  res.patch_id = pick.anchor.id;
  step(`    후보: ${pick.anchor.id}  ${(pick.anchor.size_bytes / 1e6).toFixed(1)} MB  ${pick.anchor.rows} rows  가격 ${pick.anchor.price} ${pick.anchor.currency}  검증자 ${pick.passed}인 정족수 충족 (${pick.attestations.map((a) => a.verified_on).join(', ')})`);

  // [3] 402
  const gateway = (pick.anchor as CatalogEntry['anchor'] & { gateway_url?: string }).gateway_url ?? `${market}/x402/patch/${pick.anchor.id}`;
  step(`[3] 자원 요청 → GET ${gateway}`);
  const r1 = await getJson<{ requirements?: X402Requirement[] }>(gateway, { headers: { 'x-ngram-buyer': identity.address } });
  let manifestText: string;
  let manifest: PatchManifest;
  let contentSha: string | null;
  if (r1.status === 402) {
    const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), r1.body ?? undefined);
    const want = o.pay && o.pay !== 'auto' ? o.pay : undefined;
    const req = reqs.find((q) => (want ? q.scheme === want : q.scheme === 'local-credit')) ?? reqs.find((q) => !want) ?? null;
    if (!req) throw new Error(`402 without a usable payment requirement (offered: ${reqs.map((q) => q.scheme).join(',') || 'none'})`);
    step(`    402 Payment Required: ${req.maxAmountRequired} ${req.asset} → ${req.payTo}  (${req.scheme}, nonce ${req.nonce})`);
    // [4] pay
    step(`[4] 결제 증명 생성 (${req.scheme === 'ain-transfer' ? 'AIN 체인 전송' : '서명된 크레딧 지급 의사'}) 후 재요청`);
    const payload = await payFor(req, identity, { ainProvider: o.ainProvider });
    res.scheme = payload.scheme; res.amount = req.maxAmountRequired;
    const r2 = await getJson<unknown>(gateway, { headers: { [X402_HEADER_PAYMENT]: encodePayload(payload), 'x-ngram-buyer': identity.address } }, 120_000);
    if (r2.status !== 200) throw new Error(`payment rejected: ${r2.status} ${r2.text.slice(0, 300)}`);
    manifestText = r2.text;
    manifest = JSON.parse(manifestText) as PatchManifest;
    contentSha = r2.headers.get('x-content-sha256');
    res.tx_hash = r2.headers.get('x-payment-tx-hash') ?? payload.txHash;
    step(`    정산 완료: tx ${res.tx_hash}  ${r2.headers.get('x-payment-response') ?? ''}`.trimEnd());
  } else if (r1.status === 200) {
    manifestText = r1.text; manifest = JSON.parse(manifestText) as PatchManifest; contentSha = r1.headers.get('x-content-sha256'); res.scheme = 'free';
    step('    무료 자원 — 결제 없이 매니페스트 수신');
  } else {
    throw new Error(`gateway answered ${r1.status}: ${r1.text.slice(0, 300)}`);
  }

  // [5] verify manifest + download
  const mSha = sha256Hex(manifestText);
  if (contentSha && contentSha !== mSha) throw new Error(`manifest hash mismatch: header ${contentSha} vs computed ${mSha}`);
  if (manifest.patch_sha256 !== pick.anchor.patch_sha256) throw new Error('manifest sha256 differs from the on-ledger anchor');
  step(`[5] 매니페스트 sha256 ${mSha.slice(0, 16)}… 일치 · 본문 sha256 ${manifest.patch_sha256.slice(0, 16)}… (온체인 anchor와 동일)`);
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
        step(`    수신 ${(manifest.size_bytes / 1e6).toFixed(1)} MB from ${url}`);
        lastErr = null; break;
      } catch (e) { lastErr = e as Error; }
    }
    if (lastErr) throw new Error(`download failed: ${lastErr.message}`);
  } else step('    본문 이미 보유 — 다운로드 생략');
  const got = await sha256File(dest);
  if (got !== manifest.patch_sha256) throw new Error(`sha256 mismatch after download: ${got}`);
  res.sha256 = got; res.path = dest;
  step('    sha256 == 온체인 anchor 해시 — 임의 피어 수신이어도 무결성 보장');

  // [6] runtime apply
  const repo = o.repo ?? '/mnt/newdata/qwen3.8';
  if (existsSync(join(repo, 'scripts', 'patch.py')) && modelOk) {
    let hook = false;
    try { const { stdout } = await execFileP('python3', ['-c', 'from engram import live; print("1" if live.available() else "0")'], { cwd: repo, timeout: 20_000 }); hook = stdout.trim().endsWith('1'); } catch { hook = false; }
    if (hook) {
      step('[6] 런타임 적용 (무중단)');
      const ap = await execFileP('python3', ['scripts/patch.py', 'apply', dest], { cwd: repo, timeout: 10 * 60_000 });
      step(`    ${ap.stdout.trim()}`);
      res.applied = true;
      res.after = await askModel(api, prompt, o.maxTokens ?? 8);
      const ok = !!o.expect && res.after.startsWith(o.expect);
      step(`    적용 후 답: ${JSON.stringify(res.after)}  → ${ok ? '정답' : o.expect ? '불일치' : '(기대값 미지정)'}`);
      if (!o.keep) {
        const rm = await execFileP('python3', ['scripts/patch.py', 'remove', dest], { cwd: repo, timeout: 10 * 60_000 });
        res.restored = true;
        step(`    원복 완료 (구독 종료): ${rm.stdout.trim()}`);
      }
      res.success = !o.expect || ok;
    } else {
      step('[6] 패치 훅 없음 (ENGRAM_HOOK=1 로 서빙 필요) — 적용 단계 생략');
      res.success = true;
    }
  } else {
    step(`[6] 런타임 없음 (${repo}) — 적용 단계 생략; 본문은 ${dest}`);
    res.success = true;
  }
  step(`결과: ${res.success ? '성공 — 402 구매 루프 완결' : '실패'}`);
  return res;
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
