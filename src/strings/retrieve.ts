import type { Dict } from '../i18n.js';

/**
 * Every user-facing line the retrieval layer produces, in English and Korean (design §9).
 *
 * The two conventions `strings/memory.ts` sets are kept: English is label-first (`rows {rows}`), never `{n}
 * row(s)`; Korean puts an interpolated id or number in front of a dash or a space rather than in front of a
 * particle, so no line has to choose between 이/가 and 을/를 for a ticker that is not Hangul.
 *
 * The refusals matter more than the successes here. Retrieval spends the owner's API key and, one day, their
 * money — so "no plan matches this" and "that slot is not usable" are full sentences that say what was NOT done.
 */
export const RETRIEVE_STRINGS: Dict = {
  // ---------------------------------------------------------------- the call itself
  'retrieve.paid': {
    en: 'asked {server} · {tool} — rows {rows}, already known here {refetched}, {ms} ms, queries {queries}',
    ko: '{server} · {tool} 에 질의했습니다 — 행 {rows}개, 그중 이미 알고 있던 것 {refetched}개, {ms} ms, 질의 {queries}회',
  },
  'retrieve.anonymous': {
    en: '{server} — no credential in {env}, so the connection is anonymous and the queries are attributable to nobody',
    ko: '{server} — {env} 에 자격 증명이 없어 익명으로 접속합니다. 이 질의는 아무에게도 귀속되지 않습니다',
  },
  'retrieve.stored': {
    en: 'kept for shape {shape}: rows {rows} in {file} (facts held for this shape {total}), the full provenance in {provenance}',
    ko: 'shape {shape} 로 보관했습니다: {file} 에 {rows}행 (이 shape 로 보유한 사실 {total}개), 전체 출처 기록은 {provenance}',
  },
  'retrieve.empty': {
    en: '{tool} answered with items {items} and none of them became a row ({rejected} rejected: {reasons}) — the query ran and the question is still unanswered',
    ko: '{tool} 이 항목 {items}개를 돌려줬지만 행이 된 것은 없습니다 (거절 {rejected}건: {reasons}). 질의는 나갔고 질문은 그대로 남았습니다',
  },
  'retrieve.altCollision': {
    en: 'second phrasings dropped {n} — another row answers the same question differently, and one question with two answers in one lesson is a contradiction, not a pair. The rows themselves are kept.',
    ko: '두 번째 표현을 {n}개 버렸습니다 — 같은 질문에 다른 답을 주는 행이 있어서입니다. 한 수업 안에서 한 질문에 두 답은 짝이 아니라 모순입니다. 행 자체는 그대로 둡니다.',
  },
  'retrieve.unpinned': {
    en: '{tool} did not return {keys}, so these rows are not pinned by it — the record says where they came from and not what they were true at',
    ko: '{tool} 이 {keys} 값을 돌려주지 않아 이 행들은 그 값으로 고정되지 않았습니다 — 출처는 남지만 "언제 기준으로 참이었는지"는 남지 않습니다',
  },
  'retrieve.churn': {
    en: 'answers that moved {churned} of {refetched} known facts — this shape changes underneath, so compiling it into memory would compile something already stale',
    ko: '이미 알던 사실 {refetched}개 중 {churned}개는 답이 달라졌습니다 — 이 shape 는 계속 바뀌므로, 기억으로 컴파일하면 이미 낡은 것을 굳히게 됩니다',
  },

  // ---------------------------------------------------------------- refusals: nothing was asked upstream
  'retrieve.noPlan': {
    en: 'no plan matches this question, so nothing was asked and nothing was spent. Plans held {plans}: {ids}. A plan collapses the phrasings somebody wrote down; it does not understand meaning — add a pattern to one of them, or ask in one of the ways they already know.',
    ko: '이 질문에 맞는 plan 이 없어 아무것도 묻지 않았고 아무것도 쓰지 않았습니다. 보유한 plan {plans}개: {ids}. plan 은 누군가 적어둔 표현만 묶어줄 뿐 의미를 이해하지 않습니다 — 패턴을 추가하거나, plan 이 이미 아는 방식으로 물어보세요.',
  },
  'retrieve.slotRefused': {
    en: '{plan} matched on {pattern} and the {slot} it captured is not usable — {reason}. Nothing was asked upstream.',
    ko: '{plan} 이 {pattern} 으로 매칭됐지만 잡아낸 {slot} 값을 쓸 수 없습니다 — {reason}. 상위 서버에는 아무것도 묻지 않았습니다.',
  },
  'retrieve.ambiguous': {
    en: 'plans matching this question {n} — using {plan} (it matched the most literal text). The others: {others}',
    ko: '이 질문에 맞는 plan 이 {n}개입니다 — 문자 그대로 가장 많이 일치한 {plan} 을 씁니다. 나머지: {others}',
  },
  'retrieve.planErrors': {
    en: 'plan files that did not load {n}: {files} — the plans that did load are unaffected',
    ko: '읽지 못한 plan 파일 {n}개: {files} — 정상적으로 읽힌 plan 은 그대로 씁니다',
  },

  // ---------------------------------------------------------------- failures, told apart by whether a query left
  'retrieve.failedBeforeCall': {
    en: 'could not reach {server} ({error}) — no query left this machine and the reservation was released',
    ko: '{server} 에 연결하지 못했습니다 ({error}) — 질의는 나가지 않았고 예약도 해제했습니다',
  },
  'retrieve.failedAfterCall': {
    en: '{server} · {tool} answered with a failure ({error}) — the query did leave this machine and is counted against today\'s cap',
    ko: '{server} · {tool} 이 실패로 답했습니다 ({error}) — 질의는 이미 나갔으므로 오늘 한도에서 차감합니다',
  },
  'retrieve.unmetered': {
    en: '{plan} — running without a query budget, so nothing limits how many queries this can spend. The loop never does this; a one-shot retrieval by hand may.',
    ko: '{plan} — 질의 예산 없이 실행합니다. 몇 번을 질의하든 막는 것이 없습니다. 자동 루프는 이렇게 실행하지 않으며, 손으로 한 번 돌릴 때만 쓰는 방식입니다.',
  },

  // ---------------------------------------------------------------- `agent plans`
  'plans.none': {
    en: 'no plans in {dirs} — the agent has no retrieval path at all until one is written',
    ko: '{dirs} 에 plan 이 없습니다 — plan 을 하나 쓰기 전까지 이 에이전트에는 조회 경로가 없습니다',
  },
  'plans.entry': {
    en: '{id} — {server} · {tool}, phrasings {patterns}, shape {shape} ({file})',
    ko: '{id} — {server} · {tool}, 표현 {patterns}개, shape {shape} ({file})',
  },
  'plans.checkOk': {
    en: '{id} — checked: the example slots bind, the bound call carries no leftover slot, and binding them does not change the shape',
    ko: '{id} — 점검 완료: 예시 슬롯이 결합되고, 결합된 호출에 남은 슬롯이 없으며, 결합해도 shape 가 바뀌지 않습니다',
  },
  'plans.checkFinding': {
    en: '{id} — {finding}',
    ko: '{id} — {finding}',
  },
};
