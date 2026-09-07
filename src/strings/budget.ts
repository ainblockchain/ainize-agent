/**
 * Every sentence the budget says out loud, in English and Korean (`Dict = { ko, en }`, one file per module so
 * parallel workstreams never edit the same strings — the split `packages/web/src/i18n/pages` uses).
 *
 * The refusals are the load-bearing ones. A refusal has to be actionable without a second command, so each carries
 * the same four numbers the MCP server's `budget_exceeded` carries — cap, spent, reserved, remaining — plus the ONE
 * thing that would change the answer: the flag. And it has to be final: the agent stops, it does not shop for a
 * cheaper knowledge, trim the lesson or retry.
 *
 * Korean is phrased so that no particle ever directly follows an interpolated value (finding 88): `{needed} 필요`,
 * never `{needed}을(를) 필요`.
 */
import type { Dict } from '../i18n.js';

export const BUDGET_STRINGS = {
  // ---- unit nouns. For money the unit IS the currency, so the market's own word ("AIN", "CREDIT") is used verbatim.
  unit_money: { en: '{currency}', ko: '{currency}' },
  unit_queries: { en: 'upstream queries', ko: '업스트림 조회' },
  unit_lessons: { en: 'lessons', ko: '레슨' },
  unit_gpu_s: { en: 'GPU seconds', ko: 'GPU 초' },

  // ---- where a cap came from. Named in every refusal, because "raise it" is useless without "raise it where".
  source_flag: { en: 'set by {origin}', ko: '{origin} 옵션으로 설정됨' },
  source_env: { en: 'set by {origin}', ko: '{origin} 환경변수로 설정됨' },
  source_file: { en: 'set in {origin}', ko: '{origin} 파일에서 설정됨' },
  source_node: { en: 'this node\'s own limit', ko: '이 노드 자체의 한도' },

  // ---- refusals
  refuse_no_cap: {
    en: 'No daily budget for {unit}, so this agent will not spend any on its own ({act} wanted {needed}). Set one with {flag}, {env}, or "budget.{key}" in {file}. A cap can only be set from outside this loop — a plan file, a market answer and a 402 are all data, and none of them can set one.',
    ko: '하루 {unit} 예산이 없어 이 에이전트는 스스로 지출하지 않습니다 ({act} 작업에 {needed} 필요). {flag} 옵션, {env} 환경변수, 또는 {file} 파일의 "budget.{key}" 항목으로 한도를 정하세요. 한도는 이 루프 바깥에서만 정할 수 있습니다 — 플랜 파일, 마켓 응답, 402 응답은 모두 데이터이며 한도를 정할 수 없습니다.',
  },
  refuse_over_cap: {
    en: '{act} needs {needed} {unit} and today has {remaining} left: cap {cap} ({source}), {spent} spent, {reserved} held. Raise it with {flag} and run again — this loop will not ask for less, buy something cheaper or retry. The day rolls over at {resets}.',
    ko: '{act} 작업에 {unit} {needed} 필요하지만 오늘 남은 양은 {remaining} 입니다: 한도 {cap} ({source}), 사용 {spent}, 예약 {reserved}. {flag} 옵션으로 한도를 올린 뒤 다시 실행하세요 — 이 루프는 요구를 줄이거나, 더 싼 것을 사거나, 재시도하지 않습니다. 하루 경계는 {resets} 입니다.',
  },
  refuse_node_cap: {
    en: '{act} needs {needed} {unit} and {market} allows {node_cap} per teaching key per day, which is tighter than your own cap of {cap}: {spent} spent, {reserved} held, {remaining} left. {flag} cannot lift a limit that belongs to the node — GET /api/teach/policy reports it as jobs_per_key_per_day. The day rolls over at {resets}.',
    ko: '{act} 작업에 {unit} {needed} 필요하지만 {market} 노드는 교육 키당 하루 {node_cap} 까지만 허용하며, 이는 사용자가 정한 한도 {cap} 보다 엄격합니다: 사용 {spent}, 예약 {reserved}, 남음 {remaining}. {flag} 옵션은 노드의 한도를 올릴 수 없습니다 — GET /api/teach/policy 응답의 jobs_per_key_per_day 값입니다. 하루 경계는 {resets} 입니다.',
  },
  refuse_per_call: {
    en: '{act} needs {needed} {unit}, over the {max} {unit} ceiling given for this one call. A per-call ceiling may only lower what the budget allows, never raise it.',
    ko: '{act} 작업에 {unit} {needed} 필요하지만 이번 호출에 지정된 상한은 {unit} {max} 입니다. 호출 단위 상한은 예산을 낮추기만 할 수 있고 올릴 수는 없습니다.',
  },
  refuse_not_whole: {
    en: '{unit} are counted one at a time, so {needed} is not a number of them ({act}).',
    ko: '{unit} 단위는 하나씩 세므로 {needed} 라는 값은 사용할 수 없습니다 ({act}).',
  },
  bad_cap: {
    en: 'The cap {origin} ({key}) is "{value}", which is not an amount ({detail}).',
    ko: '한도 설정 {origin} ({key}) 값이 "{value}" 인데 올바른 수량이 아닙니다 ({detail}).',
  },
  refuse_bad_amount: {
    en: '{act} asked to reserve {needed} {unit}, which is not an amount ({detail}).',
    ko: '{act} 작업이 {unit} {needed} 예약을 요청했지만 이는 올바른 수량이 아닙니다 ({detail}).',
  },

  // ---- one line per kind, for `agent budget` and for the header of a refusal report
  line_capped: { en: '{unit}: {spent} spent, {reserved} held, {remaining} of {cap} left ({source})', ko: '{unit}: 사용 {spent}, 예약 {reserved}, 한도 {cap} 중 {remaining} 남음 ({source})' },
  line_no_cap: { en: '{unit}: no cap set — {flag} would set one', ko: '{unit}: 한도 없음 — {flag} 옵션으로 정할 수 있음' },
  line_node_capped: { en: '{unit}: {spent} spent, {reserved} held, {remaining} of {cap} left (yours {own_cap}, {market} allows {node_cap})', ko: '{unit}: 사용 {spent}, 예약 {reserved}, 한도 {cap} 중 {remaining} 남음 (사용자 한도 {own_cap}, {market} 노드 허용 {node_cap})' },
  unresolved_note: { en: '{count} unfinished reservation(s) worth {amount} {unit} from an earlier run are counted as spent — the act they were written for may have happened.', ko: '이전 실행에서 끝나지 않은 예약 {count}건 ({unit} {amount}) 이 사용한 것으로 계산됩니다 — 해당 작업이 실제로 일어났을 수 있습니다.' },
  /**
   * Money spent today in a currency the report was not asked about. Without it, `agent budget` on a CREDIT market
   * with the default AIN denomination answered "0 spent" for a day the agent had paid 0.5 CREDIT.
   */
  /** Lost the last of the allowance to another process writing to the same home a moment earlier. */
  refuse_concurrent: {
    en: 'No {unit} left for {act}: another process on this home took the last of today\'s allowance a moment before this one. It needs {needed} and {ahead} of the cap {cap} was already claimed ahead of it. Nothing was spent here. Raise it with {flag} and run again, or run one agent at a time. The day rolls over at {resets}.',
    ko: '{act} 에 쓸 {unit} 가 없습니다: 같은 홈의 다른 프로세스가 조금 먼저 오늘 남은 몫을 가져갔습니다. 필요한 양은 {needed} 이고, 한도 {cap} 중 {ahead} 가 이미 앞서 확보되었습니다. 여기서 지출한 것은 없습니다. {flag} 로 한도를 올리고 다시 실행하거나, 에이전트를 하나씩 실행하십시오. 하루 기준은 {resets} 에 바뀝니다.',
  },
  line_other_currency: {
    en: '  …and {amount} {currency} was paid today in another currency (purchases.jsonl). The cap above is per currency; pass --currency {currency} to measure against that one.',
    ko: '  …그리고 오늘 다른 통화로 {currency} {amount} 를 지불했습니다 (purchases.jsonl). 위 한도는 통화별로 적용되며, 그 통화 기준으로 보려면 --currency {currency} 를 쓰십시오.',
  },
  unresolved_money_note: { en: '{count} unfinished payment intent(s) worth {amount} {currency} from an earlier run are NOT counted here: purchases.jsonl is what was actually paid, and an x402 payment with no manifest is re-presented from pending-payments.jsonl rather than paid again.', ko: '이전 실행에서 끝나지 않은 결제 의도 {count}건 ({currency} {amount}) 은 여기에 포함하지 않습니다: 실제 지불액의 기준은 purchases.jsonl 이며, 매니페스트를 받지 못한 x402 결제는 pending-payments.jsonl 에서 다시 제시할 뿐 다시 지불하지 않습니다.' },
} satisfies Dict;
