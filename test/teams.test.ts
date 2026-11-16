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

test('told to be quiet, the agent reacts and says nothing more in that thread until a person calls it again (2026-11-16 #comcom: it acknowledged in text, then answered four more messages)', async () => {
  const { decideEngagement: decide, isQuietRequest: quiet, silencedIn, QUIET_REACTION, addressingPrompt: prompt } = await import('../src/teams/index.ts');
  const HC = 'u-haechan', CH = 'u-chanho', thread = { channelId: 'ch-comcom', parentId: 'root-1' };
  const at = (history: { sender: string; text: string; agent?: boolean }[]) => parseTeamsOrigin({
    location: { kind: 'thread', id: 'ch-comcom', parentId: 'root-1' }, recipient: { id: AINA, displayName: 'AINA' },
    conversation: { messages: history.map((m, i) => ({ id: `m${i}`, sender: { id: m.sender, isAgent: !!m.agent || m.sender === AINA }, text: m.text })) },
  });
  // The thread as it was: a sign-up poll, one request for a summary, AINA's summary, more sign-ups.
  const before = [{ sender: 'u-1', text: 'ainteams, ainmem' }, { sender: HC, text: `<@${AINA}> 현황정리해줘` }, { sender: AINA, text: '현황 정리입니다 …' }, { sender: 'u-2', text: 'ain calendar' }];
  const order = `<@${AINA}>  너 내가 다시 요청할때까지 조용히있어`;
  assert.deepEqual(decide(at(before), order), { respond: false, reason: 'quiet-requested', react: QUIET_REACTION, thread }, 'seen, and no text');
  const after = [...before, { sender: HC, text: order }];
  for (const said of ['이놈 독하다.....!', 'ainteams or ainspace', '아인스페이스에 사람 좀 많이 붙어야할 것 같습니다 이름만 하나지 붙은게 한두개가 아니네요', '그래서 ainproj 는 몇 명인가요?'])
    assert.deepEqual(decide(at(after), said), { respond: false, reason: 'silenced', thread }, said);
  assert.equal(silencedIn(at(after)!.conversation!.messages, AINA), true, 'an answer still being prepared when the order came is not posted');
  // Called back by a person: answers again, and the thread is open again for follow-ups.
  assert.equal(decide(at(after), `<@${AINA}> 이제 최종 집계 올려줘`).reason, 'mentioned');
  const called = [...after, { sender: CH, text: `<@${AINA}> 이제 최종 집계 올려줘` }, { sender: AINA, text: '최종 집계입니다 …' }];
  assert.equal(silencedIn(at(called)!.conversation!.messages, AINA), false);
  assert.equal(decide(at(called), 'ainproj 는 누구누구인가요?').reason, 'thread-participant');
  // A second "be quiet" by mention is still an order, and another agent's words neither silence nor call back.
  assert.equal(decide(at(called), `<@${AINA}> 조용히 해`).reason, 'quiet-requested');
  assert.equal(silencedIn(at([...after, { sender: 'a-other', agent: true, text: `<@${AINA}> 집계 부탁` }])!.conversation!.messages, AINA), true);
  // Unaddressed in the agent's thread it is about the agent; said to a person by name, or in a thread the agent is not in, it is not.
  assert.equal(decide(at(before), '조용히 해').reason, 'quiet-requested');
  assert.equal(decide(at(before), `<@${CH}> 조용히 해 ㅋㅋ`).reason !== 'quiet-requested', true);
  assert.equal(decide(at([{ sender: 'u-1', text: '회의 중' }]), '조용히 해').reason, 'not-addressed');
  assert.equal(decide(parseTeamsOrigin({ location: { kind: 'channel', id: 'c' }, recipient: { id: AINA } }), `<@${AINA}> 그만 답해`).reason, 'quiet-requested');
  for (const yes of ['조용히 해', '조용', '너 좀 조용히 있어', '그만 답해', '이제 그만해', '답변 그만', '대답하지 마', '집계 그만 올려', '끼어들지 마', '가만히 있어', '시끄러워', 'shut up', 'be quiet', 'stop replying', "don't answer", 'AINA 멈춰'])
    assert.equal(quiet(yes), true, yes);
  for (const no of ['현황정리해줘', '이 서버는 왜 응답을 그만두나요?', 'general 사건이 생각나네요', '배포가 멈춘 원인을 알려줘', '조용한 시간대에 배포하면 어떨까요?', '서버가 멈춰 있어요', '말 안 해도 알아요', '조용히 하고 싶은데 알림이 계속 와요',
    `어제 회의에서 누가 조용히 해 달라고 했는데 그 뒤로도 알림이 계속 울려서 확인해 보니 채널 설정이 전체 수신으로 되어 있었습니다. ${'설정 화면에서 바꾸는 방법을 정리해 주세요. '.repeat(3)}`])
    assert.equal(quiet(no), false, no);
  assert.match(prompt(at(before), 'ain calendar', { agentName: 'AINA' }), /entry in a poll or sign-up/);
});
test('threadMessages() reads the thread as it is now, oldest first, marking agents', async () => {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ parent: { id: 'root-1', userId: 'u-1', content: '조사 받습니다', createdAt: '2026-11-16T05:04:18Z' },
      replies: [{ id: 'r2', userId: AINA, content: '정리입니다', createdAt: '2026-11-16T10:01:52Z', automation: 'agent' }, { id: 'r1', userId: 'u-2', content: `<@${AINA}> 조용히 있어`, createdAt: '2026-11-16T10:08:08Z' }] }) }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
  }) as any;
  const { silencedIn } = await import('../src/teams/index.ts');
  const messages = await new TeamsPoster({ url: 'https://teams.example/api/mcp', token: 't', fetchImpl }).threadMessages('root-1');
  assert.deepEqual(messages.map(m => [m.id, m.sender.isAgent]), [['root-1', false], ['r2', true], ['r1', false]]);
  assert.equal(silencedIn(messages, AINA), true);
  assert.deepEqual(calls.at(-1).params, { name: 'read_thread', arguments: { messageId: 'root-1' } });
});
