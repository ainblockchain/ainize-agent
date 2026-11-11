/**
 * @ainize/agent/research — answer a question by reading a directory tree with a tool-calling model.
 *
 * Read-only by construction: the model gets list_dir, read_file, grep and glob over one root directory (paths are
 * resolved inside it; `..`, absolute paths and symlinks out of it are refused) and nothing else — no writes, no
 * shell, no network. Works with any OpenAI-compatible chat endpoint that supports `tools`, e.g. Ainize's
 * `/v1/chat/completions` serving DeepSeek-V4.1-Flash-1017.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface ResearchModel { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number }
export interface ResearchOptions {
  root: string;
  system: string;
  question: string;
  maxTurns?: number;
  /** Stop and answer with what is known once this much wall time is used. */
  budgetMs?: number;
  onTool?: (name: string, args: unknown) => void;
}
export interface ResearchResult { answer: string; turns: number; toolCalls: number; stopped?: 'turns' | 'budget' }

const MAX_FILE = 200_000, MAX_OUT = 60_000;
const SKIP = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'coverage', '.turbo', '.cache']);

export function insideRoot(root: string, p: unknown): string {
  if (typeof p !== 'string' || p.includes('\0')) throw new Error('invalid path');
  const base = realpathSync(root);
  const full = resolve(base, p.replace(/^\/+/, ''));
  if (full !== base && !full.startsWith(base + sep)) throw new Error('path outside the root');
  try { const real = realpathSync(full); if (real !== base && !real.startsWith(base + sep)) throw new Error('path outside the root'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return full;
}

function listDir(root: string, args: { path?: string }) {
  const dir = insideRoot(root, args.path ?? '.');
  return readdirSync(dir, { withFileTypes: true }).filter(e => !SKIP.has(e.name)).slice(0, 500)
    .map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') || '(empty)';
}
function readFile(root: string, args: { path: string; offset?: number; limit?: number }) {
  const file = insideRoot(root, args.path);
  if (statSync(file).size > 5_000_000) return 'file too large to read';
  const lines = readFileSync(file, 'utf8').split('\n');
  const from = Math.max(0, (args.offset ?? 1) - 1), to = Math.min(lines.length, from + Math.min(args.limit ?? 400, 2000));
  const out = lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n');
  return (out.length > MAX_FILE ? out.slice(0, MAX_FILE) + '\n…(truncated)' : out) + (to < lines.length ? `\n…(${lines.length - to} more lines; use offset)` : '');
}
function* walk(root: string, dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(root, full, depth + 1);
    else if (e.isFile()) yield full;
  }
}
const globRe = (g: string) => new RegExp('^' + g.split('**/').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('(?:.*/)?') + '$');
function glob(root: string, args: { pattern: string; path?: string }) {
  const base = insideRoot(root, args.path ?? '.'), re = globRe(String(args.pattern || '**/*'));
  const out: string[] = [];
  for (const f of walk(root, base)) { const rel = relative(base, f); if (re.test(rel)) { out.push(relative(realpathSync(root), f)); if (out.length >= 300) break; } }
  return out.join('\n') || '(no match)';
}
function grep(root: string, args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean }) {
  const base = insideRoot(root, args.path ?? '.');
  let re: RegExp; try { re = new RegExp(String(args.pattern), args.ignoreCase ? 'i' : ''); } catch { return 'invalid regular expression'; }
  const g = args.glob ? globRe(args.glob) : null, out: string[] = [];
  const files = lstatSync(base).isFile() ? [base] : walk(root, base);
  for (const f of files) {
    if (g && !g.test(relative(base, f))) continue;
    let text: string; try { if (statSync(f).size > 2_000_000) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) {
      out.push(`${relative(realpathSync(root), f)}:${i + 1}:${lines[i].slice(0, 300)}`);
      if (out.length >= 200) return out.join('\n') + '\n…(more matches; narrow the search)';
    }
  }
  return out.join('\n') || '(no match)';
}

export const RESEARCH_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List a directory (relative to the root).', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file with line numbers. offset is 1-based; limit lines (default 400).', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a JavaScript regular expression. Optional path (file or directory) and glob filter.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignoreCase: { type: 'boolean' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by glob pattern such as **/*.ts.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
] as const;

export function runTool(root: string, name: string, args: any): string {
  try {
    const out = name === 'list_dir' ? listDir(root, args) : name === 'read_file' ? readFile(root, args) : name === 'grep' ? grep(root, args) : name === 'glob' ? glob(root, args) : `unknown tool ${name}`;
    return out.length > MAX_OUT ? out.slice(0, MAX_OUT) + '\n…(truncated)' : out;
  } catch (e) { return `error: ${(e as Error).message}`; }
}

const RETRYABLE = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'UND_ERR_CLOSED']);

/** A connection dropped before any response — typically a pooled keep-alive socket the server closed while tools ran. */
export function isDroppedConnection(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return e instanceof TypeError && !!cause?.code && RETRYABLE.has(cause.code);
}

/**
 * One model call. The reply is streamed and `timeoutMs` is the longest SILENCE allowed (before the first byte, and
 * between chunks), not a deadline for the whole call: a slow model writing a long answer over a long conversation
 * legitimately takes longer than any fixed total, while a dead one sends nothing.
 */
async function complete(m: ResearchModel, body: Record<string, unknown>): Promise<any> {
  const idleMs = m.timeoutMs ?? 300_000;
  const url = m.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  const payload = JSON.stringify({ ...body, stream: true });
  let res: Response, ctl: AbortController, timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), idleMs); };
  try {
    for (let attempt = 1; ; attempt++) {
      ctl = new AbortController(); arm();
      try {
        res = await (m.fetchImpl ?? fetch)(url, {
          method: 'POST', redirect: 'error', signal: ctl.signal,
          headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' }, body: payload,
        });
        break;
      } catch (e) { if (attempt >= 3 || !isDroppedConnection(e)) throw e; }
    }
    if (res.status === 429 || res.status === 503) throw Object.assign(new Error('model busy'), { busy: true });
    if (!res.ok) throw new Error(`model request failed (${res.status})`);
    // A server that ignores `stream` answers with one JSON document.
    if (!res.body || !/text\/event-stream/i.test(res.headers.get('content-type') ?? '')) return await res.json();
    return await readStream(res.body, arm);
  } finally { clearTimeout(timer); }
}

/** Folds OpenAI-style streamed chunks back into the non-streamed `{ choices: [{ message }] }` shape. */
async function readStream(body: ReadableStream<Uint8Array>, onChunk: () => void): Promise<any> {
  const decoder = new TextDecoder(), calls: any[] = [];
  let buffer = '', content = '', seen = false;
  const line = (raw: string) => {
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let delta: any; try { delta = JSON.parse(data)?.choices?.[0]?.delta; } catch { return; }
    if (!delta) return;
    seen = true;
    if (typeof delta.content === 'string') content += delta.content;
    for (const c of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = (calls[c.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (c.id) call.id = c.id;
      if (c.function?.name) call.function.name = c.function.name;
      if (typeof c.function?.arguments === 'string') call.function.arguments += c.function.arguments;
    }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) line(buffer.slice(0, i).trimEnd());
  }
  line(buffer.trimEnd());
  if (!seen) return { choices: [] };
  const tool_calls = calls.filter(Boolean);
  return { choices: [{ message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) } }] };
}

/** Runs the read-only tool loop and returns the model's final answer. */
export async function research(model: ResearchModel, o: ResearchOptions): Promise<ResearchResult> {
  const started = Date.now(), maxTurns = o.maxTurns ?? 40, budget = o.budgetMs ?? 8 * 60_000;
  const messages: any[] = [{ role: 'system', content: o.system }, { role: 'user', content: o.question }];
  let toolCalls = 0;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const last = turn === maxTurns || Date.now() - started > budget;
    // The final turn keeps the tool list (tool_choice none): the tools are part of the prompt prefix, so dropping them
    // makes the server re-read the whole conversation instead of reusing its cache.
    if (last) messages.push({ role: 'user', content: 'Stop investigating now and write the final answer from what you found.' });
    const r = await complete(model, { model: model.model, messages, tools: RESEARCH_TOOLS, tool_choice: last ? 'none' : 'auto', max_tokens: 4000 });
    const msg = r?.choices?.[0]?.message;
    if (!msg) throw new Error('model returned no message');
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length || last) return { answer: String(msg.content ?? '').trim(), turns: turn, toolCalls, ...(last ? { stopped: turn === maxTurns ? 'turns' as const : 'budget' as const } : {}) };
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    for (const c of calls) {
      let args: any = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad JSON → empty args */ }
      o.onTool?.(c.function?.name, args); toolCalls++;
      messages.push({ role: 'tool', tool_call_id: c.id, content: runTool(o.root, c.function?.name, args) });
    }
  }
  return { answer: '', turns: maxTurns, toolCalls, stopped: 'turns' };
}
