import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const entries = Object.fromEntries(Object.entries({ server: 'src/main.ts', 'platform-smoke': 'scripts/platform-smoke.ts', 'matrix-native': 'scripts/matrix-native.ts', 'matrix-native-smoke': 'scripts/matrix-native-smoke.ts', 'native-agent-smoke': 'scripts/native-agent-smoke.ts', 'live-call': 'scripts/live-call.ts', 'live-smoke': 'scripts/live-smoke.ts', 'agent-smoke': 'scripts/agent-smoke.ts', 'probe-codex': 'scripts/probe-codex.ts', smoke: 'scripts/smoke.ts', 'matrix-smoke': 'scripts/matrix-smoke.ts', e2e: 'scripts/e2e.ts' }).filter(([, path]) => existsSync(path)));
await build({ entryPoints: entries, outdir: 'dist', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true });
