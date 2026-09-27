import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';

/** Keep auxiliary title calls from consuming the scripted approval turn. */
export async function startApprovalMockLlmServer(options: Parameters<typeof startMockLlmServer>[0]) {
  const agent = await startMockLlmServer(options);
  const title = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
    apiKey: options.apiKey, successText: 'Workbench verification' });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(bytes.toString()) as { tools?: unknown[] };
      const target = Array.isArray(body.tools) && body.tools.length > 0 ? agent : title;
      const upstream = await fetch(`${target.baseURL}${request.url ?? '/'}`, {
        method: request.method, body: bytes,
        headers: { 'content-type': 'application/json', 'x-api-key': String(request.headers['x-api-key'] ?? '') },
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) await pipeline(Readable.from((async function* () {
        const reader = upstream.body!.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally { reader.releaseLock(); }
      })()), response);
      else response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Approval mock did not bind a TCP port');
  let closing: Promise<void> | undefined;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    port: address.port,
    randomSeed: agent.randomSeed,
    requests: agent.requests,
    async close() {
      if (closing) return closing;
      server.closeAllConnections();
      closing = Promise.all([
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        agent.close(), title.close(),
      ]).then(() => {});
      return closing;
    },
  };
}
