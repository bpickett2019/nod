import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const tools = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as unknown[];
const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.method === 'tools/call') return;
  if (message.method === 'initialize')
    return send({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'nod', version: '1' },
      },
    });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools } });
  send({ id: message.id, result: {} });
});
