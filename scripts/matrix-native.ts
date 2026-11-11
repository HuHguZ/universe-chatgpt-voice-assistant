import { createNativeMatrixServer } from '../src/matrix/native.ts';

const port = Number(process.env.UNIVERSE_MATRIX_PORT ?? 18795);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid UNIVERSE_MATRIX_PORT');
const app = await createNativeMatrixServer(process.env.UNIVERSE_API_URL);
app.server.listen(port, '127.0.0.1', () => console.log(`Universe in Element: http://127.0.0.1:${port}/matrix`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
