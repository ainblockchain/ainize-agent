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
  assert.deepEqual(decideEngagement(engaged, 'getSession 은 날짜와 상관없나요?'), { respond: true, reason: 'thread-participant', thread: { channelId: 'ch-comcom', parentId: 'root-1' }, confirm: true });
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

test('thanks in the agent thread gets a heart, a question or plain chat in it does not', async () => {
  const { decideEngagement: decide, THANKS_REACTION: heart, isThanks: thanks, addressingPrompt: prompt, parseAddressing: parse, quickDismiss: dismiss } = await import('../src/teams/index.ts');
  const o = threadOrigin([{ id: 'root-1', sender: 'user-mh', text: 'root' }, { id: 'r2', sender: AINA, text: '배포 완료했습니다' }]);
  assert.deepEqual(decide(o, '넵 잘 해결되었습니다~!').react, heart);
  assert.equal(decide(o, '감사합니다! 근데 로그인은 어디서 하나요?').react, undefined);
  assert.equal(decide(o, '감사합니다! 근데 로그인은 어디서 하나요?').confirm, true);
  assert.equal(decide(o, 'ㅋㅋ').respond, false);
  assert.equal(decide(o, 'ㅋㅋ').react, undefined);
  assert.equal(thanks('고마워요 🙏'), true);
  assert.equal(thanks('배포 해 주세요'), false);
  assert.equal(dismiss('넵', o), true);
  assert.match(prompt(o, 'getSession 은 날짜와 상관없나요?'), /AINA \(you\): 배포 완료했습니다[\s\S]*<new_message>/);
  assert.deepEqual(parse('YES asks about the deployed admin'), { answer: true, reason: 'asks about the deployed admin' });
  assert.equal(parse('maybe').answer, false);
});

test('react() calls add_reaction with the agent token', async () => {
  const calls: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await new TeamsPoster({ url: 'https://t/api/mcp', token: 't', fetchImpl }).react('m-1');
  assert.deepEqual(calls.find(c => c.method === 'tools/call').params, { name: 'add_reaction', arguments: { messageId: 'm-1', emoji: '❤️' } });
});
