/**
 * The budget and the spend ledger.
 *
 * What these assert is the difference between a budget and a comment: the cap comes only from outside the loop, the
 * hold really holds, a refusal carries the four numbers and the flag, an unfinished reservation from a dead process
 * is charged, and `purchases.jsonl` — not this ledger — remains the authority on what was paid.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  AgentBudget, BUDGET_KINDS, BudgetRefusal, dayKey, loadCaps, readSpend, resetLabel, spendFile, trainerWorstCaseSeconds,
  type SpendRow,
} from '../src/budget.js';

const DAY = 86_400_000;
/** A fixed clock well inside one UTC day, so nothing here depends on when the suite runs. */
const T = Date.parse('2026-09-07T09:00:00Z');

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'ngram-agent-budget-'));
  mkdirSync(d, { recursive: true });
  return d;
}

function open(h: string, flags: Record<string, string | number> = {}, o: { env?: NodeJS.ProcessEnv; now?: number; currency?: string } = {}) {
  return AgentBudget.open({
    home: h, flags: flags as never, env: o.env ?? {}, locale: 'en',
    currency: o.currency ?? 'AIN', now: () => o.now ?? T,
  });
}

function rows(h: string): SpendRow[] { return readSpend(h); }

/** `assert.throws` returns nothing, and every refusal here is asserted on its fields. */
function refusal(fn: () => unknown): BudgetRefusal {
  try { fn(); } catch (e) { assert.ok(e instanceof BudgetRefusal, `not a BudgetRefusal: ${String(e)}`); return e; }
  throw new assert.AssertionError({ message: 'expected a BudgetRefusal, nothing was thrown' });
}

function purchase(h: string, amount: string, asset: string, at: number) {
  appendFileSync(join(h, 'purchases.jsonl'), JSON.stringify({
    patch_id: 'p1', sha256: 'x', seller: 's', seller_name: null, gateway: 'g', market: 'm',
    amount, asset, scheme: 'local-credit', tx_hash: 't', nonce: 'n', path: 'p', at,
  }) + '\n');
}

// ---------------------------------------------------------------- caps come from outside the loop
test('a cap is read from a flag, then env, then agent.json — and from nowhere else', () => {
  const h = home();
  writeFileSync(join(h, 'agent.json'), JSON.stringify({ budget: { money_per_day: '9', queries_per_day: 40, lessons_per_day: 2, gpu_seconds_per_day: 900 } }));
  const env = { NGRAM_AGENT_QUERIES_PER_DAY: '7', NGRAM_AGENT_LESSONS_PER_DAY: '1' };

  const caps = loadCaps({ home: h, flags: { money: 3 }, env, locale: 'en' });
  assert.equal(caps.money.amount, '3');
  assert.deepEqual(caps.money.source, { via: 'flag', origin: '--budget-per-day' });
  assert.equal(caps.queries.amount, '7');
  assert.equal(caps.queries.source?.via, 'env');
  assert.equal(caps.lessons.amount, '1');
  assert.equal(caps.gpu_s.amount, '900');
  assert.equal(caps.gpu_s.source?.via, 'file');
  assert.equal(caps.gpu_s.source?.origin, join(h, 'agent.json'));
});

test('an unset cap is null, not a default this module invented', () => {
  const caps = loadCaps({ home: home(), env: {}, locale: 'en' });
  for (const k of BUDGET_KINDS) { assert.equal(caps[k].amount, null); assert.equal(caps[k].source, null); }
});

test('a malformed cap refuses at load and names where it came from', () => {
  const h = home();
  assert.throws(() => loadCaps({ home: h, flags: { money: 'lots' as never }, env: {}, locale: 'en' }), /cap --budget-per-day \(money_per_day\) is "lots"/);
  assert.throws(() => loadCaps({ home: h, env: { NGRAM_AGENT_LESSONS_PER_DAY: '0.5' }, locale: 'en' }), /cap NGRAM_AGENT_LESSONS_PER_DAY \(lessons_per_day\) is "0\.5"/);
});

test('caps are frozen — nothing inside the loop can raise one', () => {
  const b = open(home(), { money: 1 });
  assert.ok(Object.isFrozen(b.caps));
  assert.ok(Object.isFrozen(b.caps.money));
  assert.throws(() => { (b.caps.money as { amount: string | null }).amount = '1000'; }, TypeError);
  assert.equal(b.view('money').cap, '1');
});

// ---------------------------------------------------------------- check-and-hold
test('two decisions in flight cannot both squeeze past the same remainder', () => {
  const h = home();
  const b = open(h, { queries: 5 });
  const first = b.reserve({ kind: 'queries', amount: 3, act: 'mcp_call' });
  assert.equal(b.view('queries').reserved, '3');
  assert.equal(b.view('queries').remaining, '2');

  assert.throws(() => b.reserve({ kind: 'queries', amount: 3, act: 'mcp_call' }), (e: unknown) => {
    assert.ok(e instanceof BudgetRefusal);
    assert.equal(e.code, 'over_cap');
    assert.equal(e.kind, 'queries');
    assert.equal(e.flag, '--queries-per-day');
    assert.deepEqual(e.details.cap, '5');
    assert.deepEqual(e.details.spent, '0');
    assert.deepEqual(e.details.reserved, '3');
    assert.deepEqual(e.details.remaining, '2');
    return true;
  });

  first.release('nothing came back');
  assert.equal(b.view('queries').reserved, '0');
  assert.equal(b.view('queries').spent, '0');
  const second = b.reserve({ kind: 'queries', amount: 3, act: 'mcp_call' });
  second.settle();
  assert.equal(b.view('queries').spent, '3');
});

test('the intent line is written before the act, and the settle closes the same id', () => {
  const h = home();
  const b = open(h, { queries: 5 });
  const hold = b.reserve({ kind: 'queries', amount: 2, act: 'mcp_call', ref: 'shape:abc' });
  const afterIntent = rows(h);
  assert.equal(afterIntent.length, 1);
  assert.equal(afterIntent[0]!.event, 'intent');
  assert.equal(afterIntent[0]!.amount, '2');
  assert.equal(afterIntent[0]!.act, 'mcp_call');
  assert.equal(afterIntent[0]!.ref, 'shape:abc');
  assert.equal(afterIntent[0]!.day, dayKey(T));

  hold.settle();
  const after = rows(h);
  assert.equal(after.length, 2);
  assert.equal(after[1]!.event, 'settle');
  assert.equal(after[1]!.id, after[0]!.id);
  assert.equal(hold.open, false);
  // a second close is a no-op, not a second row
  hold.settle();
  hold.release('late');
  assert.equal(rows(h).length, 2);
});

test('a lesson the node refuses comes back — the node never queued it', () => {
  const h = home();
  const b = open(h, { lessons: 1 });
  const hold = b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' });
  assert.equal(b.view('lessons').remaining, '0');
  hold.release('quota_key from the node — nothing was queued');
  assert.equal(b.view('lessons').remaining, '1');
  const last = rows(h).at(-1)!;
  assert.equal(last.event, 'release');
  assert.match(last.reason!, /quota_key/);
  // and the allowance is really usable again
  b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' }).settle();
  assert.equal(b.view('lessons').remaining, '0');
});

test('a settle may report a different actual than the hold — GPU seconds settle from the measured run', () => {
  const h = home();
  const b = open(h, { gpu_s: 3600 });
  const hold = b.reserve({ kind: 'gpu_s', amount: 1800, act: 'teach_gpu', ref: 'job_1' });
  assert.equal(b.view('gpu_s').reserved, '1800');
  assert.equal(hold.settle('412.5'), '412.5');
  const v = b.view('gpu_s');
  assert.equal(v.reserved, '0');
  assert.equal(v.spent, '412.5');
  assert.equal(v.remaining, '3187.5');
});

test('releaseAll closes a hold whose handle the caller still has', () => {
  const h = home();
  const b = open(h, { queries: 5 });
  const hold = b.reserve({ kind: 'queries', amount: 4, act: 'mcp_call' });
  b.releaseAll('the agent gave up');
  assert.equal(hold.open, false);
  assert.equal(b.view('queries').reserved, '0');
  hold.settle();                                  // must not resurrect it
  assert.equal(b.view('queries').spent, '0');
});

// ---------------------------------------------------------------- refusals say the four numbers and the flag
test('the "no cap" refusal names the flag, the env var, the file key and the file', () => {
  const h = home();
  const b = open(h);
  assert.throws(() => b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' }), (e: unknown) => {
    assert.ok(e instanceof BudgetRefusal);
    assert.equal(e.code, 'no_cap');
    assert.match(e.message, /--lessons-per-day/);
    assert.match(e.message, /NGRAM_AGENT_LESSONS_PER_DAY/);
    assert.match(e.message, /budget\.lessons_per_day/);
    assert.match(e.message, new RegExp(join(h, 'agent.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(e.message, /a 402 are all data/);
    return true;
  });
  // and the refusal itself is on the record
  const last = rows(h).at(-1)!;
  assert.equal(last.event, 'refused');
  assert.equal(last.reason, 'no_cap');
});

test('an over-cap refusal carries cap, spent, reserved, remaining, the flag and the reset time', () => {
  const h = home();
  purchase(h, '2', 'AIN', T - 1000);
  const b = open(h, { money: 3 });
  const held = b.reserve({ kind: 'money', amount: '0.5', act: 'buy', currency: 'AIN' });
  assert.ok(held.open);
  const e = refusal(() => b.reserve({ kind: 'money', amount: '1', act: 'buy', currency: 'AIN' }));
  assert.equal(e.code, 'over_cap');
  assert.match(e.message, /needs 1 AIN/);
  assert.match(e.message, /cap 3 \(set by --budget-per-day\)/);
  assert.match(e.message, /2 spent/);
  assert.match(e.message, /0\.5 held/);
  assert.match(e.message, /0\.5 left/);
  assert.match(e.message, /Raise it with --budget-per-day/);
  assert.match(e.message, new RegExp(resetLabel(Date.parse('2026-09-08T00:00:00Z'))));
});

test('the refusal renders in Korean too, and it is written in Korean', () => {
  const b = open(home(), { queries: 1 });
  const e = refusal(() => b.reserve({ kind: 'queries', amount: 5, act: 'mcp_call' }));
  const ko = e.render('ko');
  assert.notEqual(ko, e.message);
  assert.match(ko, /업스트림 조회/);
  assert.match(ko, /--queries-per-day/);
  assert.match(ko, /재시도하지 않습니다/);
  assert.ok(!/[a-z]{4,} [a-z]{4,} [a-z]{4,}/.test(ko.replace(/--[a-z-]+/g, '')), `Korean string still has an English sentence: ${ko}`);
});

test('a per-call ceiling may only lower what one call is allowed', () => {
  const b = open(home(), { money: 100 });
  const e = refusal(() => b.reserve({ kind: 'money', amount: '25', act: 'buy', max: '5' }));
  assert.equal(e.code, 'per_call');
  assert.equal(e.flag, null);
  assert.match(e.message, /over the 5 AIN ceiling/);
  // it cannot go the other way: a "max" above the cap does not raise the cap
  const e2 = refusal(() => b.reserve({ kind: 'money', amount: '250', act: 'buy', max: '1000' }));
  assert.equal(e2.code, 'over_cap');
});

test('queries and lessons are counted one at a time', () => {
  const b = open(home(), { lessons: 3 });
  const e = refusal(() => b.reserve({ kind: 'lessons', amount: '1.5', act: 'teach_job' }));
  assert.equal(e.code, 'not_whole');
  assert.match(e.message, /lessons are counted one at a time/);
});

// ---------------------------------------------------------------- the node's own ceiling
test('jobsPerKeyPerDay is a second ceiling and the tighter of the two wins', () => {
  const h = home();
  const b = open(h, { lessons: 5 });
  b.applyNodeLessonLimit(2, 'http://127.0.0.1:4126');
  const v = b.view('lessons');
  assert.equal(v.cap, '5');
  assert.equal(v.node_cap, '2');
  assert.equal(v.effective_cap, '2');
  assert.equal(v.remaining, '2');

  b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' }).settle();
  b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' }).settle();
  const e = refusal(() => b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job', market: 'http://127.0.0.1:4126' }));
  assert.equal(e.code, 'node_cap');
  assert.equal(e.flag, null, 'no flag on this side can lift a limit that belongs to the node');
  assert.match(e.message, /allows 2 per teaching key per day/);
  assert.match(e.message, /tighter than your own cap of 5/);
  assert.match(e.message, /jobs_per_key_per_day/);
});

test('a node limit can only tighten — a laxer node does not raise the cap, nor undo a stricter one', () => {
  const b = open(home(), { lessons: 2 });
  b.applyNodeLessonLimit(9, 'lax-node');
  assert.equal(b.view('lessons').effective_cap, '2', 'the owner cap still binds');
  b.applyNodeLessonLimit(1, 'strict-node');
  assert.equal(b.view('lessons').effective_cap, '1');
  b.applyNodeLessonLimit(9, 'lax-node');
  assert.equal(b.view('lessons').effective_cap, '1', 'a second, laxer node does not undo the stricter one');
});

test('the node ceiling is not itself a budget — with no cap of your own the agent still refuses', () => {
  const b = open(home());
  b.applyNodeLessonLimit(10, 'generous-node');
  const e = refusal(() => b.reserve({ kind: 'lessons', amount: 1, act: 'teach_job' }));
  assert.equal(e.code, 'no_cap');
});

// ---------------------------------------------------------------- money defers to purchases.jsonl
test('what was PAID comes from purchases.jsonl, per currency, and settling does not count it twice', () => {
  const h = home();
  purchase(h, '1.5', 'AIN', T - 1000);
  purchase(h, '40', 'CREDIT', T - 1000);
  const b = open(h, { money: 5 });
  assert.equal(b.view('money', 'AIN').spent, '1.5');
  assert.equal(b.view('money', 'AIN').remaining, '3.5');
  assert.equal(b.view('money', 'CREDIT').spent, '40', 'the cap is applied per currency, as `watch` already applies it');

  // a purchase runs: hold, the money moves and runAgent appends the receipt, then we settle
  const hold = b.reserve({ kind: 'money', amount: '2', act: 'buy', currency: 'AIN', ref: 'patch_1' });
  assert.equal(b.view('money', 'AIN').remaining, '1.5');
  purchase(h, '2', 'AIN', T - 500);
  hold.settle('2');
  const v = b.view('money', 'AIN');
  assert.equal(v.spent, '3.5', 'the receipt is the authority — the settle must not add a second 2');
  assert.equal(v.remaining, '1.5');
});

test('yesterday is not today', () => {
  const h = home();
  purchase(h, '4', 'AIN', T - DAY);
  const b = open(h, { money: 5, queries: 5 });
  assert.equal(b.view('money', 'AIN').spent, '0');
  b.reserve({ kind: 'queries', amount: 2, act: 'mcp_call' }).settle();
  const yesterday = open(h, { queries: 5 }, { now: T + DAY });
  assert.equal(yesterday.view('queries').spent, '0', 'the day rolled over at UTC midnight');
});

// ---------------------------------------------------------------- crashes
test('an unfinished reservation from a dead process is charged — the act may have happened', () => {
  const h = home();
  mkdirSync(h, { recursive: true });
  appendFileSync(spendFile(h), JSON.stringify({ v: 1, id: 'r_dead', kind: 'queries', event: 'intent', amount: '3', at: T - 60_000, day: dayKey(T), act: 'mcp_call' }) + '\n');
  const b = open(h, { queries: 5 });
  const v = b.view('queries');
  assert.equal(v.spent, '3');
  assert.equal(v.remaining, '2');
  assert.deepEqual(v.unresolved, { count: 1, amount: '3', counted_as_spent: true });
});

test('an unfinished PAYMENT intent is reported but not charged — purchases.jsonl is what was paid', () => {
  const h = home();
  mkdirSync(h, { recursive: true });
  appendFileSync(spendFile(h), JSON.stringify({ v: 1, id: 'r_dead', kind: 'money', event: 'intent', amount: '3', at: T - 60_000, day: dayKey(T), act: 'buy', currency: 'AIN' }) + '\n');
  const b = open(h, { money: 5 });
  const v = b.view('money', 'AIN');
  assert.equal(v.spent, '0');
  assert.deepEqual(v.unresolved, { count: 1, amount: '3', counted_as_spent: false });
});

test('a torn last line is not a spend', () => {
  const h = home();
  const b = open(h, { queries: 5 });
  b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' }).settle();
  appendFileSync(spendFile(h), '{"v":1,"id":"r_torn","kind":"quer');
  assert.equal(open(h, { queries: 5 }).view('queries').spent, '1');
});

test('a second process writing to the same home is seen', () => {
  const h = home();
  const a = open(h, { queries: 4 });
  const bb = open(h, { queries: 4 });
  a.reserve({ kind: 'queries', amount: 3, act: 'mcp_call' }).settle();
  assert.equal(bb.view('queries').spent, '3', 'the ledger is re-read, not cached in memory');
  assert.throws(() => bb.reserve({ kind: 'queries', amount: 2, act: 'mcp_call' }), BudgetRefusal);
});

// ---------------------------------------------------------------- arithmetic and hygiene
test('the budget is decimal-string arithmetic, so 0.1 + 0.2 never overshoots a 0.3 cap', () => {
  const h = home();
  const b = open(h, { gpu_s: '0.3' });
  b.reserve({ kind: 'gpu_s', amount: '0.1', act: 'teach_gpu' }).settle();
  b.reserve({ kind: 'gpu_s', amount: '0.2', act: 'teach_gpu' }).settle();
  const v = b.view('gpu_s');
  assert.equal(v.spent, '0.3');
  assert.equal(v.remaining, '0');
});

test('zero always fits — a knowledge given away, or a stub lesson that burns no GPU second', () => {
  const h = home();
  const b = open(h);                       // no caps at all
  b.reserve({ kind: 'gpu_s', amount: 0, act: 'teach_gpu', note: 'stub backend' }).settle();
  assert.equal(b.view('gpu_s').spent, '0');
  assert.equal(rows(h).filter((r) => r.event === 'intent').length, 1);
});

test('the ledger is 0600 and its lines stay small', () => {
  const h = home();
  const b = open(h, { queries: 9 });
  b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call', ref: 'x'.repeat(400), note: 'y'.repeat(900) }).settle();
  assert.equal(statSync(spendFile(h)).mode & 0o777, 0o600);
  for (const line of readFileSync(spendFile(h), 'utf8').split('\n').filter(Boolean)) assert.ok(line.length < 1024, `line is ${line.length} bytes`);
  const r = rows(h)[0]!;
  assert.equal(r.ref!.length, 128);
  assert.equal(r.note!.length, 200);
});

test('every unit has a line, and an uncapped one says which flag would set it', () => {
  const b = open(home(), { money: 2, queries: 10 });
  const lines = b.lines('CREDIT');
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^CREDIT: 0 spent, 0 held, 2 of 2 left \(set by --budget-per-day\)$/);
  assert.match(lines[2]!, /^lessons: no cap set — --lessons-per-day would set one$/);
});

test('a reservation left open by an earlier run gets its own line, and money says why it is not charged', () => {
  const h = home();
  mkdirSync(h, { recursive: true });
  for (const r of [
    { v: 1, id: 'r_a', kind: 'queries', event: 'intent', amount: '2', at: T - 60_000, day: dayKey(T), act: 'mcp_call' },
    { v: 1, id: 'r_b', kind: 'money', event: 'intent', amount: '1', at: T - 60_000, day: dayKey(T), act: 'buy', currency: 'AIN' },
  ]) appendFileSync(spendFile(h), JSON.stringify(r) + '\n');
  const lines = open(h, { money: 5, queries: 5 }).lines('AIN');
  assert.equal(lines.length, 6);
  assert.match(lines[1]!, /1 unfinished payment intent\(s\) worth 1 AIN .* are NOT counted here: purchases\.jsonl/);
  assert.match(lines[3]!, /1 unfinished reservation\(s\) worth 2 upstream queries .* are counted as spent/);
});

// ---------------------------------------------------------------- what one lesson costs in GPU seconds
test('GPU seconds per lesson: given explicitly, or from a node that publishes it, or refused', () => {
  assert.deepEqual(trainerWorstCaseSeconds(null, 1800), { seconds: '1800', via: 'flag', origin: '--gpu-seconds-per-lesson' });
  // what GET /api/teach/policy actually returns today: no trainer timeout anywhere in it
  const policy = { limits: { jobs_per_key_per_day: 3, rows_per_job: 8 }, timing: { p50_s: null, samples: 0, simulated: true } };
  assert.equal(trainerWorstCaseSeconds(policy), null, 'a median is not a worst case, and there is no timeout published');
  assert.deepEqual(trainerWorstCaseSeconds({ limits: { trainer_timeout_s: 5400 } }), { seconds: '5400', via: 'policy', origin: 'GET /api/teach/policy limits.trainer_timeout_s' });
});

test('the spend file only appears once something is reserved', () => {
  const h = home();
  const b = open(h, { queries: 1 });
  assert.equal(existsSync(spendFile(h)), false);
  assert.deepEqual(b.views().map((v) => v.spent), ['0', '0', '0', '0']);
  b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' }).release('never mind');
  assert.equal(existsSync(spendFile(h)), true);
});

// ---------------------------------------------------------------- a report that measured the wrong currency
test('money paid today in ANOTHER currency is named, so a report cannot answer "0 spent" for a day money moved', () => {
  const h = home();
  // A CREDIT market read with the module's default AIN denomination — what `agent budget` really did on 2026-09-07,
  // the day the agent paid 0.5 CREDIT for pixelplus-demo and the report said "AIN: 0 spent".
  purchase(h, '0.5', 'CREDIT', T);
  const b = new AgentBudget(h, loadCaps({ home: h, flags: { money: '5' } }), { now: () => T, locale: 'en' });
  const v = b.view('money', 'AIN');
  assert.equal(v.spent, '0');                       // true of AIN, and true is not the same as complete
  assert.deepEqual(v.other_currencies, [{ currency: 'CREDIT', amount: '0.5' }]);
  const money = b.lines('AIN').filter((l) => /AIN|CREDIT/.test(l));
  assert.match(money.join('\n'), /0\.5 CREDIT was paid today in another currency/);
  assert.match(money.join('\n'), /--currency CREDIT/);
  // …and asked in that currency the cap does its job, with nothing left over to report
  const inCredit = b.view('money', 'CREDIT');
  assert.equal(inCredit.spent, '0.5');
  assert.equal(inCredit.remaining, '4.5');
  assert.deepEqual(inCredit.other_currencies, []);
  // the sentence exists in Korean too, with the same values in it
  const ko = new AgentBudget(h, loadCaps({ home: h, flags: { money: '5' } }), { now: () => T, locale: 'ko' }).lines('AIN').join('\n');
  assert.match(ko, /[가-힣]/);
  assert.match(ko, /CREDIT 0\.5/);
});

test('yesterday\'s spend in another currency is not today\'s business', () => {
  const h = home();
  purchase(h, '9', 'CREDIT', T - DAY);
  const b = new AgentBudget(h, loadCaps({ home: h, flags: { money: '5' } }), { now: () => T, locale: 'en' });
  assert.deepEqual(b.view('money', 'AIN').other_currencies, []);
});

// ---------------------------------------------------------------- two processes, one remainder

/**
 * The concurrent case cannot be staged in one process: `snapshot()` already counts another process's OPEN intent,
 * so two sequential reserves refuse on the ordinary path. What has to be shown is two writers that both READ before
 * either APPENDS — which needs real processes, released together. Measured before the fix: eight warm processes at
 * one instant against a cap of 3 settled EIGHT, in 7 of 10 trials.
 */
test('warm processes released at one instant cannot between them spend more than the cap', async () => {
  const h = home();
  const worker = join(h, 'worker.mjs');
  const src = pathToFileURL(join(import.meta.dirname, '..', 'src', 'budget.ts')).href;
  writeFileSync(worker, [
    `import { existsSync, writeFileSync } from 'node:fs';`,
    `const { AgentBudget } = await import(${JSON.stringify(src)});`,
    `const [home, me] = [process.argv[2], process.argv[3]];`,
    `const b = AgentBudget.open({ home, flags: { queries: '3' }, locale: 'en' });`,
    `writeFileSync(home + '/ready-' + me, '1');`,
    `while (!existsSync(home + '/go')) { /* tight spin: no timer, no I/O wait */ }`,
    `try { b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' }).settle(1); } catch { /* refused, which is the point */ }`,
  ].join('\n'));

  const N = 8;
  const kids = Array.from({ length: N }, (_, i) =>
    new Promise<void>((res) => spawn(process.execPath, ['--import', 'tsx', worker, h, String(i)], { stdio: 'ignore' }).on('exit', () => res())));
  const t0 = Date.now();
  while (readdirSync(h).filter((f) => f.startsWith('ready-')).length < N) {
    if (Date.now() - t0 > 60_000) throw new Error('the workers never became ready');
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(join(h, 'go'), '1');
  await Promise.all(kids);

  const settled = readSpend(h).filter((r) => r.event === 'settle');
  assert.equal(settled.length, 3, `${N} processes settled ${settled.length} queries against a cap of 3`);
  // every loser gave its hold straight back, so nothing is left half-held for the rest of the day
  assert.equal(readSpend(h).filter((r) => r.event === 'intent').length, settled.length + readSpend(h).filter((r) => r.event === 'release').length);
  assert.equal(new AgentBudget(h, loadCaps({ home: h, flags: { queries: '3' } }), {}).view('queries').spent, '3');
});

test('a refusal that lost the race says so, in both languages, and spends nothing', () => {
  const h = home();
  const caps = loadCaps({ home: h, flags: { queries: '1' } });
  const a = new AgentBudget(h, caps, { now: () => T, locale: 'en' });
  // b's own intent is on file and a's is ahead of it: the sequential path cannot produce this, so it is written
  // as the log really looks at that instant.
  a.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' });
  const b = new AgentBudget(h, caps, { now: () => T, locale: 'en' });
  const ref = refusal(() => b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' }));
  assert.equal(ref.code, 'over_cap');
  assert.match(ref.render('ko'), /[가-힣]/);
  assert.doesNotMatch(ref.render('ko'), /Raise it with/);
  assert.equal(readSpend(h).filter((r) => r.event === 'settle').length, 0);
});

test('the winner is the earlier LINE, and a reservation that fits is never disturbed by one that does not', () => {
  const h = home();
  const caps = loadCaps({ home: h, flags: { queries: '2' } });
  const a = new AgentBudget(h, caps, { now: () => T, locale: 'en' });
  const b = new AgentBudget(h, caps, { now: () => T, locale: 'en' });
  const one = a.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' });
  const two = b.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' });   // still fits: two of two
  assert.ok(one.open && two.open);
  refusal(() => a.reserve({ kind: 'queries', amount: 1, act: 'mcp_call' }));
  one.settle(1); two.settle(1);
  assert.equal(new AgentBudget(h, caps, { now: () => T }).view('queries').spent, '2');
});
