/**
 * Library entry. `run`'s side of the product (buy, verify, apply) plus the loop `ask` drives.
 *
 * `ask.ts` reaches `retrieve.ts` and the MCP client through a dynamic import, so importing this module costs the
 * `@ngram/core` crypto it already needed (~340 ms, measured) and about 6 ms more — not the MCP SDK, which is loaded
 * only on the branch that actually calls somebody else's server.
 */
export * from './agent.js';
export * from './identity.js';
export { ask, type AskOptions, type AskResult, type AskVia } from './ask.js';
export {
  shouldBake, nStar, bakeCosts, runBake, ETA_MIN_SAMPLES, ROWS_FLOOR_GRADIENT,
  type BakeDecision, type BakeGate, type BakePolicy, type BakeRun, type BudgetProbe, type GateName,
  type NStarKind, type NStarResult, type NStarTerm,
} from './bake.js';
export { AgentMemory, decideRecall, fetchRuntime, memoryView, rowKey, stackFingerprint } from './memory.js';
export { AgentBudget, BudgetRefusal, loadCaps, spendFile, trainerWorstCaseSeconds } from './budget.js';
export { agentLocale, translator, type Dict, type Locale } from './i18n.js';
