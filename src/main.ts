import { createSonoraServer } from './server.ts';

const port = Number(process.env.SONORA_PORT ?? 18793);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SONORA_PORT');
const app = createSonoraServer();
app.server.listen(port, '127.0.0.1', () => console.log(`Universe API: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
