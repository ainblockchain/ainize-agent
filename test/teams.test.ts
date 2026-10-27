import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamsOrigin, decideEngagement, renderThread, SILENT, TeamsPoster } from '../src/teams/index.ts';

const AINA = 'agent-aina', FINN = 'user-finn';
const threadOrigin = (history: { id: string; sender: string; text: string }[]) => parseTeamsOrigin({
  workspace: { id: 'ws' }, location: { kind: 'thread', id: 'ch-comcom', name: 'comcom', parentId: 'root-1' },
  sender: { id: FINN, displayName: 'Finn', isAgent: false }, recipient: { id: AINA, displayName: 'AINA' },
  conversation: { messages: history.map(h => ({ id: h.id, sender: { id: h.sender, ...(h.sender === AINA ? { displayName: 'AINA' } : {}) }, text: h.text })),
    current: { id: 'now', sender: { id: FINN, displayName: 'Finn' }, text: 'getSession 은 날짜와 상관없나요?' } },
});

test('a follow-up in a thread the agent answered is answered; other channel traffic is left alone', () => {
  const engaged = threadOrigin([{ id: 'root-1', sender: 'user-mh', text: '배포됐습니다' }, { id: 'r2', sender: AINA, text: '답변' }]);
  assert.deepEqual(decideEngagement(engaged, 'getSession 은 날짜와 상관없나요?'), { respond: true, reason: 'thread-participant', thread: { channelId: 'ch-comcom', parentId: 'root-1' } });
  const other = threadOrigin([{ id: 'root-1', sender: 'user-mh', text: '배포됐습니다' }]);
  assert.equal(decideEngagement(other, '점심 뭐 먹지').respond, false);
  assert.equal(decideEngagement(other, `<@${AINA}> 이거 봐줘`).reason, 'mentioned');
  assert.equal(decideEngagement(parseTeamsOrigin({ location: { kind: 'channel', id: 'c' }, recipient: { id: AINA } }), 'hello').respond, false);
  assert.equal(decideEngagement(parseTeamsOrigin({ location: { kind: 'dm', id: 'd' }, recipient: { id: AINA } }), 'hello').reason, 'direct-message');
  assert.equal(decideEngagement(null, 'hi').reason, 'not-from-teams');
  assert.equal(SILENT, '');
});

test('origin parsing drops malformed fields and the thread renders oldest first with names', () => {
  assert.equal(parseTeamsOrigin('x'), null);
  assert.equal(parseTeamsOrigin({ location: { kind: 'room', id: 'x' } }), null);
  const o = threadOrigin([{ id: 'root-1', sender: 'user-mh', text: 'root' }, { id: 'r2', sender: AINA, text: 'my answer' }]);
  const text = renderThread(o);
  assert.match(text, /user-mh: root[\s\S]*AINA: my answer[\s\S]*Finn: getSession/);
});

test('the poster replies in the thread through Teams MCP with the agent token', async () => {
  const calls: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); calls.push({ auth: init.headers.authorization, body });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ id: 'm-1' }) }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
  }) as typeof fetch;
  const id = await new TeamsPoster({ url: 'https://teams.example/api/mcp', token: 't', fetchImpl }).replyInThread({ channelId: 'c', parentId: 'p' }, '답변');
  assert.equal(id, 'm-1');
  const call = calls.find(c => c.body.method === 'tools/call');
  assert.deepEqual(call.body.params.arguments, { channelId: 'c', parentId: 'p', content: '답변' });
  assert.equal(call.auth, 'Bearer t');
});
