import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'echo') send({ id: request.id, result: request.params });
  if (request.method === 'split') {
    const data = JSON.stringify({ id: request.id, result: 'joined' }) + '\n';
    process.stdout.write(data.slice(0, 9));
    setTimeout(() => process.stdout.write(data.slice(9)), 5);
  }
  if (request.method === 'notify') {
    send({ method: 'changed', params: { value: 1 } });
    send({ id: request.id, result: {} });
  }
  if (request.method === 'fail') send({ id: request.id, error: { code: -1, message: 'expected failure' } });
  if (request.method === 'exit') process.exit(2);
}
