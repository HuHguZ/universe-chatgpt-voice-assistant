import { createLiveCallServer } from '../src/matrix/live-server.ts';

const app = await createLiveCallServer();
app.server.listen(18794, '127.0.0.1', () => console.log('Universe call: http://127.0.0.1:18794'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
