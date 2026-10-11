import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { askModelDetailed } from '../src/agent.js';

for (const status of [200, 404, 401, 429, 500]) {
  test(`model completion handles raw API status ${status} without replaying refused generation`, async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'own-model' }] }));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (req.url === '/v1/completions' && status !== 200) return void res.writeHead(status).end(JSON.stringify({ error: { code: status === 404 ? 'not_found' : 'refused' } }));
      res.end(JSON.stringify({ choices: req.url === '/v1/completions' ? [{ text: ' raw answer ' }] : [{ message: { content: ' chat answer ' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const request = askModelDetailed(`http://127.0.0.1:${address.port}`, 'own question', 16);
      if (![200, 404].includes(status)) {
        await assert.rejects(request, new RegExp(`completion failed: ${status}`));
        assert.equal(calls.length, 1);
        return;
      }
      const answer = await request;
      assert.equal(answer.text, status === 200 ? 'raw answer' : 'chat answer');
      assert.equal(answer.usage.total_tokens, 5);
      assert.equal(calls.length, status === 200 ? 1 : 2);
      if (status === 404) assert.deepEqual(calls[1].body, { model: 'own-model', messages: [{ role: 'user', content: 'own question' }], max_tokens: 16, temperature: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
