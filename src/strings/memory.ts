import type { Dict } from '../i18n.js';

/**
 * Every user-facing line the memory layer produces, in English and Korean (design §9).
 *
 * One dictionary per module, so the five build groups never edit the same string file — the reason
 * `packages/web/src/i18n` splits `pages/*.ts`.
 *
 * Two conventions, because the CLI has neither of the resolvers the web has (see `i18n.ts`):
 *  - English is label-first (`facts {rows}`), never `{n} fact(s)`. "(s)" on a screen is the visual signature of an
 *    unfinished product (finding 88), and `plural()` lives in the web app, not here.
 *  - Korean puts an id or a number in front of a dash instead of in front of a particle, so no line ever has to
 *    choose between 이/가 or 을/를 for a knowledge id that is not Hangul.
 */
export const MEMORY_STRINGS: Dict = {
  // ---------------------------------------------------------------- reconciliation (§2, rules 1–4)
  'mem.conflict.notResident': {
    en: '{patch} — memory says it is loaded and the node does not list it; demoted to held. It is owned, the body is on disk, and recall may not claim the model knows it.',
    ko: '{patch} — 기억에는 모델에 올라가 있다고 되어 있지만 노드 목록에는 없습니다. 보유(held) 상태로 낮춥니다. 소유권과 파일은 그대로이고, 모델이 안다고는 주장하지 않습니다.',
  },
  'mem.conflict.foreign': {
    en: '{patch} — on the model, and this agent does not own it. Left alone (removing it would write the model\'s own rows back over someone else\'s knowledge); it still changes the stack fingerprint, so cached answers are invalidated.',
    ko: '{patch} — 모델에 올라가 있지만 이 에이전트의 것이 아닙니다. 건드리지 않습니다(삭제하면 남의 지식 위에 모델 원래 값을 덮어씁니다). 다만 스택 지문은 바뀌므로 캐시된 답은 무효가 됩니다.',
  },
  'mem.conflict.bodyChanged': {
    en: '{patch} — the node has a different body than memory recorded ({node_sha} on the model, {agent_sha} in memory). Everything learned from it is demoted to unverified until the anchor is checked again.',
    ko: '{patch} — 노드에 올라간 본문이 기억한 것과 다릅니다(모델 {node_sha}, 기억 {agent_sha}). 이 지식에서 배운 사실은 앵커를 다시 확인할 때까지 미검증(unverified) 상태로 낮춥니다.',
  },
  'mem.conflict.homeEmpty': {
    en: 'no memory in {home} — rebuilt from the node and the receipts: knowledge {engrams}, facts {rows}. The lookup history cannot be rebuilt, so the shape counters start at zero and nothing will be baked on a memory this agent does not have.',
    ko: '{home} — 기억이 없습니다. 노드와 영수증에서 복구했습니다: 지식 {engrams}개, 사실 {rows}개. 조회 이력은 복구할 수 없으므로 shape 카운터는 0에서 다시 시작하고, 없는 기억 위에서 학습(bake)하지 않습니다.',
  },
  'mem.conflict.noRuntime': {
    en: '{market} — the node did not answer GET /api/runtime ({error}), so what is on the model is unknown; memory is left exactly as it is and nothing is demoted on a guess.',
    ko: '{market} — 노드가 GET /api/runtime에 답하지 않았습니다({error}). 모델에 무엇이 올라가 있는지 알 수 없으므로 기억은 그대로 두고, 추측으로 상태를 낮추지 않습니다.',
  },
  /**
   * The state change alone. WHY it changed is the `why` field of the `demote` event on disk — a log field in the
   * node's own vocabulary, like `reason` in its `applied` table — and the sentence a reader gets is the translated
   * conflict line above it, never an English reason wedged into a Korean line.
   */
  'mem.demoted': {
    en: '{what} — state {from} → {to}',
    ko: '{what} — 상태 {from} → {to}',
  },

  // ---------------------------------------------------------------- recall (§4)
  'mem.recall.cache': {
    en: 'answered from memory — {engram} has taught this since {date}, and the model has not changed since the answer was checked ({age} ago). No query, no completion, no cost.',
    ko: '기억에서 답했습니다 — {date}부터 {engram} 지식이 알고 있고, 답을 확인한 뒤({age} 전) 모델이 바뀌지 않았습니다. 조회도, 생성도, 비용도 없습니다.',
  },
  'mem.recall.confirm': {
    en: 'in memory since {date} — asking the model once, and scoring its answer against the remembered one. That one call is the answer as well as the check.',
    ko: '{date}부터 기억하고 있습니다 — 모델에 한 번만 물어보고 그 답을 기억한 답과 대조합니다. 이 한 번의 호출이 확인이자 곧 답입니다.',
  },
  'mem.recall.offline': {
    en: 'answered from memory with nothing to check it against ({why}) — the answer is labelled as remembered, not as the model\'s.',
    ko: '대조할 대상이 없어 기억에서 답했습니다({why}) — 이 답은 모델의 답이 아니라 기억한 답으로 표시됩니다.',
  },
  'mem.recall.miss': {
    en: 'not in memory (facts held {rows}) — this question has to be paid for: a knowledge that covers it, or a lookup.',
    ko: '기억에 없습니다(보유한 사실 {rows}개) — 이 질문은 비용을 치러야 합니다: 이 내용을 담은 지식을 사거나, 조회하거나.',
  },
  'mem.recall.unverified': {
    en: 'in memory but unverified ({why}) — memory is a claim and the model is the truth, so this falls through to the cost path.',
    ko: '기억에는 있지만 미검증 상태입니다({why}) — 기억은 주장이고 모델이 사실이므로, 비용을 치르는 경로로 넘깁니다.',
  },
  'mem.recall.mismatch': {
    en: '{row} — the model answered {got} where memory held {expected}; the fact is demoted to unverified. Memory is a claim; the model is the truth.',
    ko: '{row} — 기억은 {expected}였는데 모델은 {got}라고 답했습니다. 이 사실을 미검증으로 낮춥니다. 기억은 주장이고, 모델이 사실입니다.',
  },

  /**
   * The reasons the recall lines above interpolate. They are dictionary entries rather than English written in the
   * code, because a Korean sentence with an English clause wedged into its `{why}` is not a translated sentence.
   */
  'mem.own': { en: 'its own memory', ko: '자체 기억' },
  'mem.why.noModel': { en: 'there is no serving model to ask', ko: '물어볼 서빙 모델이 없습니다' },
  'mem.why.notResident': { en: '{patch} is not on the model', ko: '{patch} — 모델에 올라가 있지 않습니다' },
  'mem.why.modelDisagreed': { en: 'the model answered otherwise', ko: '모델이 다르게 답했습니다' },
  'mem.why.bodyChanged': { en: '{patch} changed underneath', ko: '{patch} — 본문이 바뀌었습니다' },

  // ---------------------------------------------------------------- `agent memory` (§9)
  'mem.view.summary': {
    en: 'memory {home} — facts {rows} · knowledge {engrams} (on the model {loaded}, held {held}, unverified {unverified}) · shapes {shapes} · events {events}',
    ko: '기억 {home} — 사실 {rows}개 · 지식 {engrams}개(모델 적재 {loaded}, 보유 {held}, 미검증 {unverified}) · shape {shapes}개 · 이벤트 {events}건',
  },
  'mem.view.empty': {
    en: 'nothing in memory yet — {file} does not exist. Nothing has been learned, bought, retrieved or baked by this agent.',
    ko: '아직 기억이 없습니다 — {file} 파일이 없습니다. 이 에이전트가 배우거나 사거나 조회하거나 학습한 것이 없습니다.',
  },
  'mem.view.stack': {
    en: 'the model at {api} — model {model} · layers {layers} · fingerprint {fp}',
    ko: '{api}의 모델 — 모델 {model} · 레이어 {layers}개 · 지문 {fp}',
  },
  'mem.view.noStack': {
    en: 'no runtime — the market node reports no model, so residency is unknown and every remembered answer is labelled as remembered.',
    ko: '런타임이 없습니다 — 마켓 노드가 모델을 보고하지 않으므로 적재 여부를 알 수 없고, 기억한 답은 모두 기억한 답으로 표시됩니다.',
  },
  'mem.view.shape': {
    en: '{shape} — lookups {lookups} · rows {rows} (new {new_rows}, refetched {refetched}, churned {churned}) · retrieval samples {retrieval_n} · recall samples {recall_n} · bakes {bake_n}',
    ko: '{shape} — 조회 {lookups}회 · 행 {rows}개(신규 {new_rows}, 재조회 {refetched}, 변동 {churned}) · 조회 측정 {retrieval_n}건 · 회상 측정 {recall_n}건 · 학습 {bake_n}회',
  },
};
