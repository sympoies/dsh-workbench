import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { startApprovalMockLlmServer } from './approval-mock.ts';

test('title requests cannot consume the approval tool-call sequence', async () => {
  const apiKey = randomBytes(24).toString('hex');
  const mock = await startApprovalMockLlmServer({ sequence: ['tool_call_success', 'success'],
    repeatLast: true, successText: 'APPROVAL_FINISHED', apiKey,
    toolName: 'bash', toolArguments: JSON.stringify({ command: 'printf approval' }) });
  try {
    const request = async (tools?: unknown[]) => {
      const response = await fetch(`${mock.baseURL}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ model: 'fixture', max_tokens: 64, stream: false,
          messages: [{ role: 'user', content: 'Fixture request' }], ...(tools ? { tools } : {}) }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)) as { type: string; content_block?: { type: string } });
      return { content: events.flatMap(event => event.content_block ? [event.content_block] : []) };
    };
    const title = await request();
    assert.ok(title.content.every(block => block.type === 'text'), 'Title consumed the Bash tool response');
    const agent = await request([{ name: 'bash', input_schema: { type: 'object' } }]);
    assert.ok(agent.content.some(block => block.type === 'tool_use'), 'Agent missed its Bash tool response');
    const continuation = await request([{ name: 'bash', input_schema: { type: 'object' } }]);
    assert.ok(continuation.content.every(block => block.type === 'text'));
    assert.deepEqual(mock.requests.map(row => row.behavior), ['tool_call_success', 'success']);
  } finally {
    await mock.close();
  }
});
