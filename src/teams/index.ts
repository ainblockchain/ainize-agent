/**
 * @ainize/agent/teams — what every agent in AIN Teams needs to behave the same way.
 *
 * AIN Teams sends each A2A `message/send` with the origin in `params.message.metadata` (ainteams
 * backend/src/domain/shared/a2a-origin.ts): where the message was written, who wrote it, who is receiving it,
 * and the conversation so far. With the workspace receive mode "Receive everything" an agent also gets messages
 * that were not addressed to it; an empty reply (no text, no files) makes Teams stay silent.
 *
 * Policy shared by all agents (decideEngagement):
 *   - direct messages are always answered;
 *   - a message that mentions the agent (`<@agentId>`) is answered;
 *   - a reply in a thread the agent already took part in (it wrote the root or any reply) is answered;
 *   - anything else is left alone (reply with SILENT).
 * Teams allows 120 s for an answer; work that takes longer answers now and posts the result later with
 * TeamsPoster (the agent's own Teams MCP token).
 */

export type LocationKind = 'channel' | 'dm' | 'thread';
export interface TeamsPerson { id: string; displayName?: string; isAgent?: boolean }
export interface TeamsHistoryMessage { id?: string; createdAt?: string; sender: TeamsPerson; text: string }
export interface TeamsOrigin {
  workspace?: { id: string; name?: string };
  location?: { kind: LocationKind; id: string; name?: string; parentId?: string };
  sender?: Partial<TeamsPerson>;
  recipient?: { id: string; displayName?: string };
  conversation?: { messages: TeamsHistoryMessage[]; current?: TeamsHistoryMessage; truncated?: boolean };
}

/** Teams treats an empty answer without files as "no reply". */
export const SILENT = '';

const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
function person(v: unknown): TeamsPerson | undefined {
  const o = obj(v); const id = str(o?.id, 200);
  return id ? { id, ...(str(o?.displayName) ? { displayName: str(o?.displayName) } : {}), ...(typeof o?.isAgent === 'boolean' ? { isAgent: o.isAgent } : {}) } : undefined;
}
function historyMessage(v: unknown): TeamsHistoryMessage | undefined {
  const o = obj(v); const sender = person(o?.sender); const text = typeof o?.text === 'string' ? o.text : undefined;
  if (!sender || text === undefined) return undefined;
  return { sender, text, ...(str(o?.id, 200) ? { id: str(o?.id, 200) } : {}), ...(str(o?.createdAt, 64) ? { createdAt: str(o?.createdAt, 64) } : {}) };
}

/** Reads the origin Teams puts in `message.metadata`. Unknown shapes are dropped, never thrown. */
export function parseTeamsOrigin(metadata: unknown): TeamsOrigin | null {
  const m = obj(metadata); if (!m) return null;
  const out: TeamsOrigin = {};
  const ws = obj(m.workspace); if (str(ws?.id, 200)) out.workspace = { id: str(ws?.id, 200)!, ...(str(ws?.name) ? { name: str(ws?.name) } : {}) };
  const loc = obj(m.location);
  if (loc && ['channel', 'dm', 'thread'].includes(String(loc.kind)) && str(loc.id, 200))
    out.location = { kind: loc.kind as LocationKind, id: str(loc.id, 200)!, ...(str(loc.name) ? { name: str(loc.name) } : {}), ...(str(loc.parentId, 200) ? { parentId: str(loc.parentId, 200) } : {}) };
  const sender = person(m.sender); if (sender) out.sender = sender;
  const recipient = person(m.recipient); if (recipient) out.recipient = { id: recipient.id, ...(recipient.displayName ? { displayName: recipient.displayName } : {}) };
  const conv = obj(m.conversation);
  if (conv) {
    const messages = Array.isArray(conv.messages) ? conv.messages.map(historyMessage).filter((x): x is TeamsHistoryMessage => !!x) : [];
    const current = historyMessage(conv.current);
    out.conversation = { messages, ...(current ? { current } : {}), ...(conv.truncated === true ? { truncated: true } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

export type EngagementReason = 'not-from-teams' | 'direct-message' | 'mentioned' | 'thread-participant' | 'not-addressed';
export interface Engagement { respond: boolean; reason: EngagementReason; thread?: { channelId: string; parentId: string } }

/** The shared answer-or-stay-silent rule (see the module comment). */
export function decideEngagement(origin: TeamsOrigin | null, text: string, self?: { id?: string }): Engagement {
  if (!origin?.location) return { respond: true, reason: 'not-from-teams' };
  const me = self?.id ?? origin.recipient?.id;
  const { location } = origin;
  const thread = location.kind === 'thread' && location.parentId ? { channelId: location.id, parentId: location.parentId } : undefined;
  if (location.kind === 'dm') return { respond: true, reason: 'direct-message', ...(thread ? { thread } : {}) };
  if (me && text.includes(`<@${me}>`)) return { respond: true, reason: 'mentioned', ...(thread ? { thread } : {}) };
  if (thread && me && (origin.conversation?.messages ?? []).some(m => m.sender.id === me)) return { respond: true, reason: 'thread-participant', thread };
  // Teams only delivers a channel message that does not mention the agent in "Receive everything" mode,
  // or a reply in a thread the agent started — the latter shows up as participation in the history.
  return { respond: false, reason: 'not-addressed', ...(thread ? { thread } : {}) };
}

/** The conversation as plain text for a model prompt (oldest first), names instead of ids. */
export function renderThread(origin: TeamsOrigin | null, opts: { maxChars?: number; selfLabel?: string } = {}): string {
  const me = origin?.recipient?.id;
  const label = (p: TeamsPerson) => (p.id === me ? (opts.selfLabel ?? origin?.recipient?.displayName ?? 'me') : (p.displayName ?? p.id));
  const lines = (origin?.conversation?.messages ?? []).map(m => `[${m.createdAt ?? ''}] ${label(m.sender)}: ${m.text}`);
  const cur = origin?.conversation?.current;
  if (cur && !(origin?.conversation?.messages ?? []).some(m => m.id && m.id === cur.id)) lines.push(`[${cur.createdAt ?? 'now'}] ${label(cur.sender)}: ${cur.text}`);
  let out = lines.join('\n');
  const max = opts.maxChars ?? 60_000;
  if (out.length > max) out = '…(earlier messages omitted)\n' + out.slice(out.length - max);
  return (origin?.conversation?.truncated ? '…(Teams sent only the latest part of the conversation)\n' : '') + out;
}

/** Posts as the agent itself through AIN Teams MCP with the agent's token (scope messages:write). */
export class TeamsPoster {
  private session: string | null = null;
  constructor(private readonly cfg: { url: string; token: string; clientName?: string; fetchImpl?: typeof fetch }) {}
  private async rpc(method: string, params?: unknown, notification = false): Promise<any> {
    const id = crypto.randomUUID();
    const res = await (this.cfg.fetchImpl ?? fetch)(this.cfg.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session, 'mcp-protocol-version': '2025-03-26' } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
    });
    if (!res.ok) throw new Error(`AIN Teams MCP unavailable (${res.status})`);
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const body = await res.text();
    if (notification) return undefined;
    const payloads = res.headers.get('content-type')?.includes('text/event-stream') ? [...body.matchAll(/^data: (.+)$/gm)].map(m => m[1]) : [body];
    for (const p of payloads) {
      let msg: any; try { msg = JSON.parse(p); } catch { continue; }
      if (msg.id !== id) continue;
      if (msg.error) throw new Error('AIN Teams MCP error');
      return msg.result;
    }
    throw new Error('AIN Teams MCP returned no result');
  }
  private async ready() {
    if (this.session) return;
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: this.cfg.clientName ?? '@ainize/agent/teams', version: '0.1.0' } });
    await this.rpc('notifications/initialized', undefined, true);
  }
  /** Replies in a channel thread; returns the new message id when Teams reports it. */
  async replyInThread(thread: { channelId: string; parentId: string }, content: string): Promise<string | null> {
    await this.ready();
    const result = await this.rpc('tools/call', { name: 'send_message', arguments: { channelId: thread.channelId, parentId: thread.parentId, content } });
    if (result?.isError) throw new Error('AIN Teams refused the post');
    const text = result?.content?.find((b: any) => b?.type === 'text')?.text;
    try { const parsed = JSON.parse(text); return typeof parsed?.id === 'string' ? parsed.id : (parsed?.message?.id ?? null); } catch { return null; }
  }
}
