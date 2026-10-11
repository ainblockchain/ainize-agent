import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { askModelDetailed } from '../src/agent.js';

for (const [status, code] of [[200, ''], [404, 'not_found'], [404, 'model_not_found'], [405, 'method_not_allowed'], [401, 'refused'], [429, 'refused'], [500, 'refused']] as const) {
  test(`model completion handles raw API status ${status} ${code} without replaying refused generation`, async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'own-model' }] }));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (req.url === '/v1/completions' && status !== 200) return void res.writeHead(status).end(JSON.stringify({ error: { code } }));
      res.end(JSON.stringify({ choices: req.url === '/v1/completions' ? [{ text: ' raw answer ' }] : [{ message: { content: ' chat answer ' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const request = askModelDetailed(`http://127.0.0.1:${address.port}`, 'own question', 16);
      const fallback = (status === 404 && code === 'not_found') || status === 405;
      if (status !== 200 && !fallback) {
        await assert.rejects(request, new RegExp(`completion failed: ${status}`));
        assert.equal(calls.length, 1);
        return;
      }
      const answer = await request;
      assert.equal(answer.text, status === 200 ? 'raw answer' : 'chat answer');
      assert.equal(answer.usage.total_tokens, 5);
      assert.equal(calls.length, fallback ? 2 : 1);
      if (fallback) assert.deepEqual(calls[1].body, { model: 'own-model', messages: [{ role: 'user', content: 'own question' }], max_tokens: 16, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
