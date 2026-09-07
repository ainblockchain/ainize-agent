/**
 * Retrieval plans, and the **shape** the agent counts its own lookups on (design §5).
 *
 * Two ideas, and they are deliberately separate:
 *
 *  1. **A plan is declarative JSON**, for the same reason a `RowMapping` is (`@ngram/mcp/rows.ts`): it can be
 *     logged, reviewed by a person, stored in provenance and re-run. A plan says which MCP server to ask, which
 *     tool, with which arguments, how to turn the answer into `{prompt, answer}` rows — and which *declared*
 *     phrasings of a question it answers, in English and Korean, in the same list.
 *  2. **The shape key does not hash the question. It hashes the retrieval.** The agent cannot reliably tell that
 *     two sentences mean the same thing and must not pretend to; it knows exactly that it ran the same query
 *     against the same server with a different argument. `skeleton()` replaces every leaf literal of the arguments
 *     with a typed placeholder, and a GraphQL document with its own literals replaced, so `USDC` today and `WETH`
 *     tomorrow produce ONE shape — which is exactly where an exact-match counter never fires.
 *
 * What this file is honest about: `match.patterns` collapses phrasings that somebody **wrote down**. It does not
 * understand meaning. A question that matches nothing is not retrieved at all — `matchQuestion` returns no
 * candidate and the caller prints the plans it has, rather than guessing a query with somebody else's API key and
 * somebody else's money. The retroactive counter that catches what the patterns missed lives in `retrieve.ts`
 * (`refetched`): a row key already in memory proves this agent paid twice for one fact, however it was worded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsSha256, stableJson, type RowMapping } from '@ngram/mcp/client';

/** Re-exported so the loop can hash a bound call without importing the MCP client itself (and its SDK) to do it. */
export { argumentsSha256 };

// ------------------------------------------------------------------------------------------------ the schema

export interface PlanServer {
  /** How the connection is named in provenance (`subgraph-mcp`). Never a secret. */
  name: string;
  transport: 'sse' | 'http' | 'stdio';
  /** sse / http. */
  url?: string;
  /** stdio. */
  command?: string;
  args?: string[];
  /**
   * Environment variables that may hold the bearer token, in order of preference. A plan names the VARIABLE; a
   * credential itself never appears in a plan file, which is data and may have been written by somebody else.
   */
  auth_env?: string[];
  timeout_ms?: number;
  max_result_bytes?: number;
}

/** What a slot captured from a question is allowed to be, before it is substituted into a query. */
export interface PlanSlot {
  /** Anchored regex (unicode). Default: `DEFAULT_SLOT_PATTERN` — no quote, brace, backslash or newline. */
  pattern?: string;
  max_length?: number;
  /** Applied after the pattern check, so the upstream gets the case it expects. */
  transform?: 'upper' | 'lower';
  /** A value that must bind, used by `planSelfCheck` and printed by `agent plans`. */
  example?: string;
}

export interface PlanMatchSpec {
  /** `{slot}` templates, English and Korean in one list. */
  patterns: string[];
  /** Slots that must be bound for a match to count. */
  requires?: string[];
  slots?: Record<string, PlanSlot>;
}

export interface AgentPlan {
  id: string;
  description?: string;
  server: PlanServer;
  tool: string;
  /** The call, with `{slot}` templates. Substituted at bind time; nothing else is templated. */
  arguments: Record<string, unknown>;
  mapping: RowMapping;
  match: PlanMatchSpec;
  /** Facts that pin the answer and are known before the call (subgraph id, network). `{slot}` allowed. */
  upstream?: Record<string, string | number | boolean | null>;
  /**
   * Facts that pin the answer and are only in the ANSWER — `{ "block": "data._meta.block.number" }`. Lifted from
   * the same response the rows came from, never from a second call that could see a different block.
   */
  upstream_from?: Record<string, string>;
  /** Which `upstream` keys belong in each row's one-line note (the node caps a note at 500 chars). */
  note_fields?: string[];
  /** Set by the loader. */
  file?: string;
}

export class PlanError extends Error {
  constructor(message: string, readonly code: string, readonly file?: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * The default a slot must satisfy. A slot value is interpolated into a GraphQL document that is then run with the
 * owner's API key, so the characters that could end a string literal or open a selection set are refused here,
 * once, rather than escaped in four places later.
 */
export const DEFAULT_SLOT_PATTERN = '^[\\p{L}\\p{N}][\\p{L}\\p{N} ._:/-]{0,63}$';
const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLOT_REF = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseServer(raw: unknown, file: string | undefined, id: string): PlanServer {
  if (!isRecord(raw)) throw new PlanError(`${id}: "server" must be an object`, 'plan_invalid', file);
  const name = raw.name;
  const transport = raw.transport;
  if (typeof name !== 'string' || !name.trim()) throw new PlanError(`${id}: server.name is required`, 'plan_invalid', file);
  if (transport !== 'sse' && transport !== 'http' && transport !== 'stdio') {
    throw new PlanError(`${id}: server.transport must be sse, http or stdio (got ${JSON.stringify(transport)})`, 'plan_invalid', file);
  }
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command) throw new PlanError(`${id}: a stdio server needs server.command`, 'plan_invalid', file);
  } else if (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url)) {
    throw new PlanError(`${id}: server.url must be an http(s) URL for a ${transport} server`, 'plan_invalid', file);
  }
  const authEnv = raw.auth_env === undefined ? undefined : raw.auth_env;
  if (authEnv !== undefined && (!Array.isArray(authEnv) || authEnv.some((x) => typeof x !== 'string'))) {
    throw new PlanError(`${id}: server.auth_env must be a list of environment variable NAMES`, 'plan_invalid', file);
  }
  for (const v of (authEnv as string[] | undefined) ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v)) throw new PlanError(`${id}: server.auth_env holds a variable name, not a value (${v.slice(0, 12)}…)`, 'plan_secret_in_plan', file);
  }
  return {
    name, transport,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(Array.isArray(raw.args) ? { args: raw.args.map(String) } : {}),
    ...(authEnv ? { auth_env: authEnv as string[] } : {}),
    ...(typeof raw.timeout_ms === 'number' ? { timeout_ms: raw.timeout_ms } : {}),
    ...(typeof raw.max_result_bytes === 'number' ? { max_result_bytes: raw.max_result_bytes } : {}),
  };
}

function parseMapping(raw: unknown, file: string | undefined, id: string): RowMapping {
  if (!isRecord(raw)) throw new PlanError(`${id}: "mapping" must be an object`, 'plan_invalid', file);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new PlanError(`${id}: mapping.prompt is required`, 'plan_invalid', file);
  if (typeof raw.answer !== 'string' || !raw.answer.trim()) throw new PlanError(`${id}: mapping.answer is required`, 'plan_invalid', file);
  return raw as unknown as RowMapping;
}

function parseMatch(raw: unknown, file: string | undefined, id: string): PlanMatchSpec {
  if (!isRecord(raw)) throw new PlanError(`${id}: "match" must be an object`, 'plan_invalid', file);
  const patterns = raw.patterns;
  if (!Array.isArray(patterns) || !patterns.length || patterns.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new PlanError(`${id}: match.patterns must be a non-empty list of {slot} templates`, 'plan_invalid', file);
  }
  const slots: Record<string, PlanSlot> = {};
  if (raw.slots !== undefined) {
    if (!isRecord(raw.slots)) throw new PlanError(`${id}: match.slots must be an object keyed by slot name`, 'plan_invalid', file);
    for (const [k, v] of Object.entries(raw.slots)) {
      if (!SLOT_NAME.test(k)) throw new PlanError(`${id}: "${k}" is not a usable slot name (letters, digits and _ only)`, 'plan_invalid', file);
      if (!isRecord(v)) throw new PlanError(`${id}: match.slots.${k} must be an object`, 'plan_invalid', file);
      if (v.pattern !== undefined) {
        if (typeof v.pattern !== 'string') throw new PlanError(`${id}: match.slots.${k}.pattern must be a string`, 'plan_invalid', file);
        try { new RegExp(v.pattern, 'u'); } catch (e) { throw new PlanError(`${id}: match.slots.${k}.pattern is not a regex: ${(e as Error).message}`, 'plan_invalid', file); }
      }
      if (v.transform !== undefined && v.transform !== 'upper' && v.transform !== 'lower') {
        throw new PlanError(`${id}: match.slots.${k}.transform must be "upper" or "lower"`, 'plan_invalid', file);
      }
      slots[k] = v as PlanSlot;
    }
  }
  const names = new Set<string>();
  for (const p of patterns as string[]) for (const m of p.matchAll(SLOT_REF)) names.add(m[1] as string);
  const requires = raw.requires === undefined ? undefined : raw.requires;
  if (requires !== undefined && (!Array.isArray(requires) || requires.some((x) => typeof x !== 'string'))) {
    throw new PlanError(`${id}: match.requires must be a list of slot names`, 'plan_invalid', file);
  }
  for (const r of (requires as string[] | undefined) ?? []) {
    if (!names.has(r)) throw new PlanError(`${id}: match.requires names {${r}}, which no pattern captures`, 'plan_invalid', file);
  }
  return { patterns: patterns as string[], ...(requires ? { requires: requires as string[] } : {}), ...(Object.keys(slots).length ? { slots } : {}) };
}

/** Validate one plan document. Every refusal names the plan, the field and what was wrong with it. */
export function parsePlan(raw: unknown, file?: string): AgentPlan {
  if (!isRecord(raw)) throw new PlanError('a plan file must hold a JSON object', 'plan_invalid', file);
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9/_-]{2,63}$/.test(id)) {
    throw new PlanError(`"id" must be a lowercase path-like name (got ${JSON.stringify(id)})`, 'plan_invalid', file);
  }
  if (typeof raw.tool !== 'string' || !raw.tool.trim()) throw new PlanError(`${id}: "tool" is required`, 'plan_invalid', file);
  if (!isRecord(raw.arguments)) throw new PlanError(`${id}: "arguments" must be an object`, 'plan_invalid', file);
  const plan: AgentPlan = {
    id,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    server: parseServer(raw.server, file, id),
    tool: raw.tool,
    arguments: raw.arguments,
    mapping: parseMapping(raw.mapping, file, id),
    match: parseMatch(raw.match, file, id),
    ...(isRecord(raw.upstream) ? { upstream: raw.upstream as AgentPlan['upstream'] } : {}),
    ...(isRecord(raw.upstream_from) ? { upstream_from: Object.fromEntries(Object.entries(raw.upstream_from).map(([k, v]) => [k, String(v)])) } : {}),
    ...(Array.isArray(raw.note_fields) ? { note_fields: raw.note_fields.map(String) } : {}),
    ...(file ? { file } : {}),
  };
  // Every slot the call needs must be capturable by some pattern, or the plan can never run.
  for (const ref of unresolvedSlots(plan)) {
    throw new PlanError(`${id}: the call uses {${ref}}, which no pattern captures and no slot declares`, 'plan_invalid', file);
  }
  return plan;
}

/** Slot names any pattern captures, plus any the plan declares a rule for. */
export function declaredSlots(plan: AgentPlan): Set<string> {
  const out = new Set<string>(Object.keys(plan.match.slots ?? {}));
  for (const p of plan.match.patterns) for (const m of p.matchAll(SLOT_REF)) out.add(m[1] as string);
  return out;
}

/**
 * Every `{name}` a value carries. Inside a GraphQL document the braces are ambiguous — `{id}` is a one-field
 * selection set as often as it is a slot — so `gqlStringsOnly` decides which reading is used:
 *
 *  - `false` mirrors what `substitute()` actually does (a DECLARED name is replaced wherever it appears), and is
 *    what "which slots does this call use" means;
 *  - `true` is the conservative reading used to refuse a plan that references a slot nobody declared, where a false
 *    positive would reject a perfectly good compact query.
 */
export function templateRefs(value: unknown, gqlStringsOnly: boolean): Set<string> {
  const out = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      if (gqlStringsOnly && isGraphQLDocument(v)) {
        for (const lit of v.match(/"(?:\\.|[^"\\])*"/g) ?? []) for (const m of lit.matchAll(SLOT_REF)) out.add(m[1] as string);
        return;
      }
      for (const m of v.matchAll(SLOT_REF)) out.add(m[1] as string);
      return;
    }
    if (Array.isArray(v)) { v.forEach(scan); return; }
    if (isRecord(v)) { Object.values(v).forEach(scan); }
  };
  scan(value);
  return out;
}

/** The three places a slot may travel to: the call, the row templates' constants, and the pinning facts. */
const templated = (plan: AgentPlan): unknown[] => [plan.arguments, plan.mapping.constants ?? {}, plan.upstream ?? {}];

/**
 * Slot names the CALL uses. Only `arguments`, `mapping.constants` and `upstream` are templated with slots —
 * `mapping.prompt`/`answer`/`note` are row templates over the upstream's own fields and are never touched.
 */
export function referencedSlots(plan: AgentPlan): Set<string> {
  const declared = declaredSlots(plan);
  const out = new Set<string>();
  for (const part of templated(plan)) for (const name of templateRefs(part, false)) if (declared.has(name)) out.add(name);
  return out;
}

/** `{name}`s the call carries that no pattern captures and no slot declares — a plan that can never run. */
export function unresolvedSlots(plan: AgentPlan): Set<string> {
  const declared = declaredSlots(plan);
  const out = new Set<string>();
  for (const part of templated(plan)) for (const name of templateRefs(part, true)) if (!declared.has(name)) out.add(name);
  return out;
}

// ------------------------------------------------------------------------------------------------ the loader

/** `packages/agent/plans` — the plans that ship with the agent. */
export function builtinPlansDir(): string {
  return fileURLToPath(new URL('../plans/', import.meta.url));
}

export interface LoadedPlans {
  plans: AgentPlan[];
  /** A bad file never kills the loader: the other plans still load and the failure is reported. */
  errors: { file: string; error: string }[];
  dirs: string[];
}

/**
 * Built-in plans first, then `<home>/plans`, so an owner's file with the same id replaces the shipped one and the
 * replacement is visible (`agent plans` prints the file every plan came from).
 */
export function loadPlans(opts: { home?: string; dirs?: string[] } = {}): LoadedPlans {
  const dirs = opts.dirs ?? [builtinPlansDir(), ...(opts.home ? [join(opts.home, 'plans')] : [])];
  const by = new Map<string, AgentPlan>();
  const errors: { file: string; error: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const file = join(dir, name);
      try {
        const plan = parsePlan(JSON.parse(readFileSync(file, 'utf8')), file);
        by.set(plan.id, plan);
      } catch (e) {
        errors.push({ file, error: (e as Error).message });
      }
    }
  }
  return { plans: [...by.values()].sort((a, b) => a.id.localeCompare(b.id)), errors, dirs };
}

// ------------------------------------------------------------------------------------- question → plan → slots

/**
 * The one normalization both sides of a match go through: NFKC (so a full-width ＵＳＤＣ is the same question as
 * USDC), lowercase, collapsed whitespace, and a trailing question mark or period removed. It is declared here
 * rather than spread over the matcher so that what the agent does and does not collapse can be read in one place.
 */
export function foldQuestion(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[?!.。？！]+$/u, '').trim();
}

export interface CompiledPattern {
  source: string;
  regex: RegExp;
  slots: string[];
  /** Characters of literal (non-slot) text, folded — how specific this pattern is. */
  literal_length: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `{slot}` template → an anchored regex with a named capture per slot. Literal spaces compile to `\s*` because
 * Korean spacing is optional in exactly the places a pattern would otherwise have to enumerate ("USDC 컨트랙트 주소"
 * and "USDC컨트랙트주소" are one question); the slots stay non-greedy so a literal that follows still wins.
 */
export function compilePattern(template: string): CompiledPattern {
  const folded = foldQuestion(template);
  const slots: string[] = [];
  let re = '';
  let literal = 0;
  let last = 0;
  for (const m of folded.matchAll(SLOT_REF)) {
    const name = m[1] as string;
    if (!SLOT_NAME.test(name)) throw new PlanError(`"${name}" is not a usable slot name`, 'plan_invalid');
    if (slots.includes(name)) throw new PlanError(`pattern "${template}" captures {${name}} twice`, 'plan_invalid');
    const lit = folded.slice(last, m.index);
    literal += lit.trim().length;
    re += escapeRe(lit).replace(/\\?\s/g, '\\s*');
    re += `(?<${name}>.+?)`;
    slots.push(name);
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = folded.slice(last);
  literal += tail.trim().length;
  re += escapeRe(tail).replace(/\\?\s/g, '\\s*');
  return { source: template, regex: new RegExp(`^${re}$`, 'u'), slots, literal_length: literal };
}

export interface PlanCandidate {
  plan: AgentPlan;
  pattern: string;
  pattern_index: number;
  slots: Record<string, string>;
  literal_length: number;
}

export interface SlotRefusal {
  plan_id: string;
  pattern: string;
  slot: string;
  value: string;
  reason: string;
}

/** A captured value, checked against the slot's rule and put in the case the upstream expects. */
export function checkSlot(name: string, raw: string, rule: PlanSlot | undefined): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  const max = rule?.max_length ?? 64;
  if (value.length > max) return { ok: false, reason: `longer than ${max} characters` };
  const pattern = rule?.pattern ?? DEFAULT_SLOT_PATTERN;
  if (!new RegExp(pattern, 'u').test(value)) return { ok: false, reason: `does not match ${pattern}` };
  const out = rule?.transform === 'upper' ? value.toUpperCase() : rule?.transform === 'lower' ? value.toLowerCase() : value;
  return { ok: true, value: out };
}

export interface MatchResult {
  /** Best first: most literal text matched, then fewest slots, then plan id, then the order the plan lists them. */
  matches: PlanCandidate[];
  /** A pattern that matched but whose captured value is not usable — reported, never silently escaped. */
  refusals: SlotRefusal[];
}

export function matchQuestion(plans: AgentPlan[], question: string): MatchResult {
  const folded = foldQuestion(question);
  const matches: PlanCandidate[] = [];
  const refusals: SlotRefusal[] = [];
  for (const plan of plans) {
    for (const [i, pattern] of plan.match.patterns.entries()) {
      let compiled: CompiledPattern;
      try { compiled = compilePattern(pattern); } catch { continue; }
      const m = compiled.regex.exec(folded);
      if (!m) continue;
      const slots: Record<string, string> = {};
      let bad = false;
      for (const name of compiled.slots) {
        const checked = checkSlot(name, m.groups?.[name] ?? '', plan.match.slots?.[name]);
        if (!checked.ok) {
          refusals.push({ plan_id: plan.id, pattern, slot: name, value: (m.groups?.[name] ?? '').slice(0, 64), reason: checked.reason });
          bad = true;
          break;
        }
        slots[name] = checked.value;
      }
      if (bad) continue;
      if ((plan.match.requires ?? []).some((r) => slots[r] === undefined)) continue;
      matches.push({ plan, pattern, pattern_index: i, slots, literal_length: compiled.literal_length });
    }
  }
  matches.sort((a, b) =>
    b.literal_length - a.literal_length ||
    Object.keys(a.slots).length - Object.keys(b.slots).length ||
    a.plan.id.localeCompare(b.plan.id) ||
    a.pattern_index - b.pattern_index);
  return { matches, refusals };
}

// ------------------------------------------------------------------------------------------------ binding

export interface BoundPlan {
  plan_id: string;
  server: PlanServer;
  tool: string;
  arguments: Record<string, unknown>;
  mapping: RowMapping;
  upstream: Record<string, string | number | boolean | null>;
  note_fields: string[] | undefined;
  slots: Record<string, string>;
}

function substitute(value: unknown, slots: Record<string, string>, missing: Set<string>, declared: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(SLOT_REF, (whole, name: string) => {
      if (!declared.has(name)) return whole;          // a row template's {field}, not a slot
      const v = slots[name];
      if (v === undefined) { missing.add(name); return whole; }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, slots, missing, declared));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, slots, missing, declared);
    return out;
  }
  return value;
}

/**
 * Fill the plan's slots. Only `arguments`, `mapping.constants` and `upstream` are substituted; `mapping.prompt`,
 * `answer`, `alt_prompt` and `note` keep their `{field}` templates, which `mapRows` renders from the upstream's
 * own items. An unbound slot is refused rather than sent as the literal text `{symbol}`.
 */
export function bindPlan(plan: AgentPlan, slots: Record<string, string>): BoundPlan {
  const declared = declaredSlots(plan);
  for (const [k, v] of Object.entries(slots)) {
    const checked = checkSlot(k, v, plan.match.slots?.[k]);
    if (!checked.ok) throw new PlanError(`${plan.id}: {${k}} = ${JSON.stringify(v.slice(0, 40))} is not usable — ${checked.reason}`, 'plan_slot_refused', plan.file);
    slots = { ...slots, [k]: checked.value };
  }
  const missing = new Set<string>();
  const args = substitute(plan.arguments, slots, missing, declared) as Record<string, unknown>;
  const constants = substitute(plan.mapping.constants ?? {}, slots, missing, declared) as Record<string, string | number>;
  const upstream = substitute(plan.upstream ?? {}, slots, missing, declared) as Record<string, string | number | boolean | null>;
  if (missing.size) {
    throw new PlanError(`${plan.id}: the call needs {${[...missing].join('}, {')}} and the question did not bind it`, 'plan_slot_missing', plan.file);
  }
  return {
    plan_id: plan.id,
    server: plan.server,
    tool: plan.tool,
    arguments: args,
    mapping: { ...plan.mapping, ...(Object.keys(constants).length ? { constants } : {}) },
    upstream,
    note_fields: plan.note_fields,
    slots,
  };
}

// ------------------------------------------------------------------------------------------------ the shape

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** What a leaf literal is, as far as a shape is concerned. The value itself never survives. */
export function typedPlaceholder(s: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return '$addr';
  if (/^(0x)?[0-9a-fA-F]{32,}$/.test(s)) return '$hash';
  if (/^-?\d+$/.test(s)) return '$int';
  if (/^-?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return '$dec';
  if (ISO_DATE.test(s)) return '$date';
  return '$str';
}

/** A string that is a GraphQL document rather than a value — the one leaf whose structure is worth keeping. */
export function isGraphQLDocument(s: string): boolean {
  const t = s.trim();
  if (!/^(\{|query\b|mutation\b|subscription\b|fragment\b)/.test(t)) return false;
  if (!/\}\s*$/.test(t)) return false;
  if (!/\s/.test(t)) return false;                                   // `{symbol}` is a slot template, not a query
  return /\{[^{}]*[A-Za-z_][A-Za-z0-9_]*[^{}]*\}/.test(t);
}

/**
 * A GraphQL document with its literals removed and its formatting normalized: comments dropped, string and number
 * literals replaced by the same typed placeholders, whitespace around punctuation collapsed. Field names and the
 * selection structure survive, because asking for a different field IS a different shape — but paging from
 * `first: 5` to `first: 20`, or filtering `symbol: "USDC"` instead of `"WETH"`, is not.
 */
export function graphqlSkeleton(doc: string): string {
  let s = doc.replace(/#[^\n]*/g, ' ');
  s = s.replace(/"""[\s\S]*?"""/g, '"$str"');
  s = s.replace(/"(?:\\.|[^"\\])*"/g, (m) => {
    let inner = m.slice(1, -1);
    try { inner = JSON.parse(m) as string; } catch { /* keep the raw inner text */ }
    return `"${typedPlaceholder(inner)}"`;
  });
  s = s.replace(/(^|[^A-Za-z0-9_$."])(-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_])/g,
    (_m, pre: string, num: string) => `${pre}${typedPlaceholder(num)}`);
  s = s.replace(/\s+/g, ' ').replace(/\s*([{}()\[\]:,=@!])\s*/g, '$1').trim();
  return s;
}

/**
 * Every leaf literal replaced by what KIND of thing it was. Objects keep their key order sorted (the same walk
 * `stableJson` does), arrays drop duplicate placeholders — so a call listing three ipfs hashes and a call listing
 * two are one shape, which is what "the same lookup with different arguments" means.
 */
export function skeleton(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return '$bool';
  if (typeof value === 'number') return Number.isInteger(value) ? '$int' : '$dec';
  if (typeof value === 'string') {
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return '$str';   // an unbound slot stands for its value
    return isGraphQLDocument(value) ? `gql:${graphqlSkeleton(value)}` : typedPlaceholder(value);
  }
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const v of value) {
      const s = skeleton(v);
      const k = stableJson(s);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = skeleton(value[k]);
    return out;
  }
  return '$str';
}

/** Exactly what is hashed — kept as a value so `agent memory --why <shape>` can print the shape, not just its id. */
export interface ShapeDescriptor {
  server: string;
  tool: string;
  arguments: unknown;
  path: string | null;
  prompt: string;
  answer: string;
}

export function shapeDescriptor(input: { server: PlanServer | string; tool: string; arguments: Record<string, unknown>; mapping: RowMapping }): ShapeDescriptor {
  return {
    server: typeof input.server === 'string' ? input.server : input.server.name,
    tool: input.tool,
    arguments: skeleton(input.arguments),
    path: input.mapping.path ?? null,
    prompt: input.mapping.prompt,
    answer: input.mapping.answer,
  };
}

export const shapeKey = (d: ShapeDescriptor): string => sha256(stableJson(d));

/** The shape of a call that is about to be made — the one the counters use. */
export const shapeOf = (bound: Pick<BoundPlan, 'server' | 'tool' | 'arguments' | 'mapping'>): string => shapeKey(shapeDescriptor(bound));

/** The shape of the plan itself, before any slot is bound. Equal to `shapeOf` for a well-formed plan. */
export const planShape = (plan: AgentPlan): string => shapeKey(shapeDescriptor({ server: plan.server, tool: plan.tool, arguments: plan.arguments, mapping: plan.mapping }));

/** 12 hex — enough to name a shape in a log line, never used as an identity. */
export const shortShape = (shape: string): string => shape.slice(0, 12);

/**
 * What `agent plans --check` runs. The one property that matters: **binding a slot must not change the shape**.
 * If it does, every entity looked up gets its own counter and the agent will never notice it is repeating itself —
 * so it is a finding, reported against the plan, before a single query is spent.
 */
export function planSelfCheck(plan: AgentPlan): string[] {
  const findings: string[] = [];
  const declared = declaredSlots(plan);
  const referenced = referencedSlots(plan);
  for (const name of declared) {
    if (!referenced.has(name) && !(plan.match.requires ?? []).includes(name)) {
      findings.push(`{${name}} is captured by a pattern and used by nothing — the question binds it and the call ignores it`);
    }
  }
  const examples: Record<string, string> = {};
  for (const name of referenced) {
    const ex = plan.match.slots?.[name]?.example;
    if (!ex) { findings.push(`{${name}} has no match.slots.${name}.example, so the plan cannot be checked without spending a query`); continue; }
    examples[name] = ex;
  }
  if (Object.keys(examples).length === referenced.size) {
    try {
      const bound = bindPlan(plan, examples);
      if (shapeOf(bound) !== planShape(plan)) {
        findings.push('binding the example slots changes the shape — the counter would start again for every entity (quote a slot that lands inside a GraphQL string, or give it a typed value)');
      }
      const left = [...templateRefs(bound.arguments, true)].filter((n) => declared.has(n));
      if (left.length) findings.push(`the bound call still contains {${left.join('}, {')}}`);
    } catch (e) {
      findings.push(`the example slots do not bind: ${(e as Error).message}`);
    }
  }
  for (const p of plan.match.patterns) {
    try { compilePattern(p); } catch (e) { findings.push(`pattern ${JSON.stringify(p)}: ${(e as Error).message}`); }
  }
  return findings;
}
