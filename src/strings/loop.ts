import type { Dict } from '../i18n.js';

/**
 * Every user-facing line the LOOP produces — the four steps of `ask`, the four bake gates, and the sentences the
 * agent uses to refuse to bake (design §6, §9).
 *
 * One dictionary per module, so the build groups never edit the same string file. The conventions are the memory
 * dictionary's: English is label-first and never says "(s)"; Korean never puts a particle after an interpolated
 * value, because the CLI has no particle resolver (see `i18n.ts`).
 *
 * The refusals are the important half of this file. An agent that spends money and GPU time has to be able to say
 * WHY it did not act, with the arithmetic in the sentence, and every one of these lines carries the numbers the
 * decision was made from — not a verdict on its own.
 */
export const LOOP_STRINGS: Dict = {
  // ---------------------------------------------------------------- the loop's four steps (§1)
  'ask.question': {
    en: 'question: {question}',
    ko: '질문: {question}',
  },
  'ask.answer.memory': {
    en: 'answered from memory — {engram} has taught this since {date}. No query, no completion, no cost.',
    ko: '기억에서 답했습니다 — {date}부터 {engram} 지식으로 알고 있던 내용입니다. 조회도, 모델 호출도, 비용도 없습니다.',
  },
  'ask.answer.model': {
    en: 'answered by the model — one completion, {ms} ms{tokens}',
    ko: '모델이 답했습니다 — 모델 호출 1회, {ms} ms{tokens}',
  },
  'ask.answer.retrieval': {
    en: 'answered from what was just retrieved — rows {rows} from {server}, and they are in memory now',
    ko: '방금 조회한 결과로 답했습니다 — {server}에서 {rows}행을 받았고, 이제 기억에 있습니다',
  },
  'ask.answer.none': {
    en: 'no answer: memory does not hold it, no knowledge on {market} covers it, and no plan matches the question.',
    ko: '답하지 못했습니다: 기억에 없고, {market}에서 파는 지식 중 이 질문을 담은 것이 없으며, 질문에 맞는 조회 계획도 없습니다.',
  },
  'ask.buy.found': {
    en: 'a knowledge on sale covers this — {patch}, {price} {currency}, attested {passed} of {quorum}. Buying it, applying it, and keeping it.',
    ko: '이 질문을 담은 지식이 판매 중입니다 — {patch}, {price} {currency}, 검증 {passed}/{quorum}. 구매하고 적용한 뒤 그대로 둡니다.',
  },
  'ask.buy.none': {
    en: 'no knowledge on {market} covers this question — falling through to the retrieval path, which costs a query every time it is asked.',
    ko: '{market}에는 이 질문을 담은 지식이 없습니다 — 조회 경로로 넘어갑니다. 이 경로는 물어볼 때마다 조회 비용이 듭니다.',
  },
  'ask.buy.learned': {
    en: 'learned facts {rows} from {patch} — its benchmark samples, which is all an anchor carries on chain.',
    ko: '{patch}에서 사실 {rows}개를 기억에 넣었습니다 — 온체인 앵커가 담고 있는 벤치마크 샘플이 전부입니다.',
  },
  'ask.plan.none': {
    en: 'no retrieval plan matches this question. A plan collects the phrasings it was told about; it does not guess. Plans loaded: {plans}',
    ko: '이 질문에 맞는 조회 계획이 없습니다. 계획은 미리 적어 둔 표현만 알아보며, 뜻을 추측하지 않습니다. 불러온 계획: {plans}',
  },
  'ask.plan.matched': {
    en: 'plan {plan} matches — shape {shape}, slots {slots}',
    ko: '계획 {plan}에 해당합니다 — shape {shape}, 슬롯 {slots}',
  },

  // ---------------------------------------------------------------- the bake decision (§6)
  'bake.trigger': {
    en: 'this is lookup {n} of shape {shape}; N* = {nstar} from measurements {samples} — compiling it into memory.',
    ko: 'shape {shape} 조회가 {n}번째입니다. 측정 {samples}건으로 계산한 N* = {nstar} — 기억으로 컴파일합니다.',
  },
  'bake.trigger.declared': {
    en: 'this is lookup {n} of shape {shape}, and --bake-after {n_declared} was declared. This is a POLICY the owner set, not a measured break-even — N* is {nstar_state}.',
    ko: 'shape {shape} 조회가 {n}번째이고, --bake-after {n_declared} 가 지정되어 있습니다. 이것은 소유자가 정한 정책이며 측정된 손익분기점이 아닙니다 — N* 상태: {nstar_state}.',
  },
  'bake.blocked.economic': {
    en: 'not baking {shape}: lookups {n} have not reached N* = {nstar}. Retrieving is still the cheaper of the two.',
    ko: '{shape} 학습을 보류합니다: 조회 {n}회는 N* = {nstar} 에 못 미칩니다. 아직은 조회하는 쪽이 쌉니다.',
  },
  'bake.blocked.nstar': {
    en: 'not baking {shape}: N* is not computable — {missing}. Declare a floor with --bake-after <n> to compile it anyway, and it will be labelled a policy.',
    ko: '{shape} 학습을 보류합니다: N*를 계산할 수 없습니다 — {missing}. --bake-after <n> 으로 기준을 직접 정하면 컴파일하며, 그 경우 정책으로 표시됩니다.',
  },
  'bake.blocked.material': {
    // NOT "the node refuses it": `teach.rowsPerJob` is a CEILING on questions per lesson, and floorGradient is what
    // that ceiling falls back to. It is used as a material floor because a handful of facts is not a knowledge.
    en: 'not baking {shape}: distinct facts {rows}, under the {floor} this agent will spend a non-refundable lesson on (the node\'s own teach.rowsPerJob.floorGradient). A handful of facts is not a knowledge.',
    ko: '{shape} 학습을 보류합니다: 서로 다른 사실이 {rows}개로, 환불되지 않는 학습권을 쓸 최소치 {floor}개에 못 미칩니다 (노드 자신의 teach.rowsPerJob.floorGradient 값). 사실 몇 개는 지식이 아닙니다.',
  },
  'bake.blocked.stability': {
    en: 'not baking {shape}: churn {churn} is over --max-churn {max}. A fact that moved between two pulls is a fact the compiled copy would be wrong about — it belongs in The Graph, on the tail.',
    ko: '{shape} 학습을 보류합니다: 변동률 {churn} 이 --max-churn {max} 를 넘습니다. 두 번의 조회 사이에 값이 바뀐 사실은 컴파일해 두면 틀리게 됩니다 — 그런 사실은 The Graph 쪽에 두는 것이 맞습니다.',
  },
  'bake.blocked.budget': {
    en: 'not baking {shape}: {kind} would pass today\'s cap. {detail}',
    ko: '{shape} 학습을 보류합니다: {kind} 한도를 넘습니다. {detail}',
  },
  'bake.blocked.noRows': {
    en: 'not baking {shape}: nothing was retrieved for it in this home, so there is no training set to build.',
    ko: '{shape} 학습을 보류합니다: 이 홈에서 조회한 결과가 없어 만들 학습 데이터가 없습니다.',
  },
  'bake.submitting': {
    en: 'ainizing {shape}: facts {rows} → training set → lesson on {market} (backend {backend}), gpu seconds reserved {gpu_s}',
    ko: '{shape} 를 ainize 합니다: 사실 {rows}개 → 학습 데이터 → {market} 학습 작업 (backend {backend}), GPU 예약 {gpu_s}초',
  },
  'bake.submitted': {
    en: 'lesson {job} submitted — dataset {dataset}, state {state}',
    ko: '학습 작업 {job} 제출됨 — 데이터셋 {dataset}, 상태 {state}',
  },
  'bake.done': {
    en: 'ainized: lesson {job} ended {state} after {total_s} s of wall clock. The engram is KEPT and private.',
    ko: 'ainize 완료: 학습 작업 {job} 이 {total_s}초(실측 경과 시간) 만에 {state} 로 끝났습니다. 결과물은 그대로 비공개로 보관합니다.',
  },
  'bake.failed': {
    en: 'the lesson ended {state}: {reason}. It still spent one of today\'s lessons — the node charges at submit and does not refund. Nothing is retried automatically.',
    ko: '학습 작업이 {state} 로 끝났습니다: {reason}. 그래도 오늘의 학습권 1개는 소모되었습니다 — 노드는 제출 시점에 차감하고 환불하지 않습니다. 자동으로 재시도하지 않습니다.',
  },
  'bake.stub': {
    en: 'this node runs NGRAM_TEACH_BACKEND=stub: the lesson record, the dataset and the state machine are real, and the knowledge file is a fixture that trains no weights. Nothing here measures a model.',
    ko: '이 노드는 NGRAM_TEACH_BACKEND=stub 으로 동작합니다: 학습 작업 기록과 데이터셋, 상태 전이는 실제이지만 결과 파일은 가중치를 학습하지 않은 고정 샘플입니다. 여기서 나온 값으로 모델을 평가할 수 없습니다.',
  },
  'bake.autoNeverPublishes': {
    en: 'the loop does not publish. Publishing writes an anchor nobody can recall, and the rows came from somebody else\'s data through a gateway key — that is the owner\'s decision, and it is one command: {command}',
    ko: '자동 루프는 공개하지 않습니다. 공개는 되돌릴 수 없는 앵커를 남기고, 사용한 데이터도 게이트웨이 키를 통해 받은 남의 데이터입니다 — 공개 여부는 소유자가 정하며, 명령 한 줄이면 됩니다: {command}',
  },
  'bake.identityWarning': {
    en: 'the lesson is signed with this agent\'s own identity ({address}) — the same key that pays for its purchases. Everything it bakes and everything it buys is attributable to one address on a public record.',
    ko: '학습 작업은 이 에이전트 자신의 신원({address})으로 서명됩니다 — 구매 대금을 내는 키와 같은 키입니다. 학습한 것과 구매한 것이 공개 기록에서 하나의 주소로 묶입니다.',
  },

  // ---------------------------------------------------------------- surfaces
  'view.budget.header': {
    en: 'budgets today (UTC day, home {home})',
    ko: '오늘의 예산 (UTC 기준, 홈 {home})',
  },
  'view.plans.header': {
    en: 'retrieval plans loaded from {dir}',
    ko: '{dir} 에서 불러온 조회 계획',
  },
  'view.plans.none': {
    en: 'no plans in {dir}. A plan is declarative JSON naming a server, a tool, the arguments and the phrasings it answers — `ainize-agent plans --check` validates one.',
    ko: '{dir} 에 계획이 없습니다. 계획은 서버, 도구, 인자, 그리고 알아들을 표현을 적은 선언적 JSON입니다 — `ainize-agent plans --check` 로 검사할 수 있습니다.',
  },
  'view.why.header': {
    en: 'why shape {shape} has (not) been compiled',
    ko: 'shape {shape} 를 컴파일했는지, 안 했다면 왜 안 했는지',
  },

  // ---------------------------------------------------------------- things that went wrong, said in both languages
  'ask.model.unreachable': {
    en: 'the serving model did not answer ({why}) — answering from memory instead, labelled as remembered',
    ko: '서빙 모델이 답하지 않았습니다 ({why}) — 대신 기억에서 답하며, 기억한 답이라고 표시합니다',
  },
  'ask.model.mismatch': {
    en: 'the model said {got} and memory held {remembered} — the remembered fact is demoted, and this question falls through to the cost path',
    ko: '모델은 {got} 라고 답했고 기억은 {remembered} 을 가지고 있었습니다 — 기억한 사실을 강등하고, 이 질문은 비용 경로로 넘어갑니다',
  },
  'ask.catalog.failed': {
    en: 'the catalog could not be read ({why}) — nothing was bought',
    ko: '카탈로그를 읽지 못했습니다 ({why}) — 아무것도 사지 않았습니다',
  },
  'ask.buy.failed': {
    en: 'the purchase failed ({why}) — nothing was settled against the money budget',
    ko: '구매에 실패했습니다 ({why}) — 금액 예산에서 정산된 것은 없습니다',
  },
  'ask.plan.unreadable': {
    en: 'plan {file} could not be read: {why}',
    ko: '계획 파일 {file} 을 읽지 못했습니다: {why}',
  },
  'ask.retrieve.failed': {
    en: 'the retrieval failed ({why})',
    ko: '조회에 실패했습니다 ({why})',
  },
  'ask.answer.paraphrase': {
    en: 'the plan answers {prompt} — which is what was asked, in the plan\'s own words',
    ko: '계획이 답하는 질문은 {prompt} 입니다 — 물어본 것과 같은 내용이고, 표현만 계획의 것입니다',
  },

  // ---------------------------------------------------------------- the bake, when it cannot proceed as written
  'bake.rowsUnreadable': {
    en: 'unreadable lines in the retrieved rows file: {n}. They were left out of the training set.',
    ko: '조회 결과 파일에서 읽지 못한 줄: {n}개. 학습 데이터에서 제외했습니다.',
  },
  'bake.noPreflight': {
    en: 'the node reports no serving model, so the preflight cannot run — the lesson is submitted without asking what the model already knows, and it still costs one of today\'s lessons',
    ko: '노드에 서빙 모델이 없다고 보고되어 프리플라이트를 실행할 수 없습니다 — 모델이 이미 아는 것을 묻지 않은 채 학습을 제출하며, 오늘의 학습권 1개는 그대로 소모됩니다',
  },
  'bake.gpuZero': {
    en: 'the stub backend starts no trainer, so this lesson holds 0 GPU seconds — a measured zero, not an unknown',
    ko: 'stub 백엔드는 트레이너를 실행하지 않으므로 이 학습은 GPU 0초를 예약합니다 — 모르는 값이 아니라 측정된 0입니다',
  },
  'bake.gpuUnknown': {
    en: 'not baking: this node runs the {backend} trainer and does not publish its timeout (GET /api/teach/policy has no limits.trainer_timeout_s), so there is no worst case to hold against the GPU-second budget. Give it with --gpu-seconds-per-lesson. Nothing was spent.',
    ko: '학습하지 않습니다: 이 노드는 {backend} 트레이너를 쓰지만 그 타임아웃을 공개하지 않습니다 (GET /api/teach/policy 에 limits.trainer_timeout_s 가 없습니다). GPU 초 예산에 잡을 최악값이 없습니다. --gpu-seconds-per-lesson 옵션으로 알려주세요. 아무것도 쓰지 않았습니다.',
  },
  'bake.notSubmitted': {
    en: 'the lesson was not submitted ({why}) — no lesson and no GPU second were spent',
    ko: '학습을 제출하지 못했습니다 ({why}) — 학습권도 GPU 초도 쓰지 않았습니다',
  },
};
