import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

test('leaving during join or transport startup never enables the microphone', async () => {
  const html = await readFile(new URL('../src/matrix/call.html', import.meta.url), 'utf8');
  const source = html.split('<script type="module">')[1]!.split('</script>')[0]!.replace("import '/browser.js';", '');
  for (const pending of ['join', 'start']) {
    const blocked = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, setAttribute() {} });
      return elements.get(id);
    };
    let microphones = 0;
    const document = { getElementById: element, body: { dataset: {} as Record<string, string> } };
    const matrix = {
      state: undefined as any,
      async start() { this.state = { closed: false }; if (pending === 'start') { reached.resolve(); await blocked.promise; } },
      async close() { if (this.state) this.state.closed = true; },
      async enableMicrophone() { microphones++; },
    };
    runInNewContext(source, {
      window: { sonoraMatrix: matrix, addEventListener() {} }, document, setInterval() {}, navigator: { sendBeacon() {} },
      async fetch(path: string) {
        if (path === '/join' && pending === 'join') { reached.resolve(); await blocked.promise; }
        return { ok: true, status: path === '/join' ? 200 : 204, async json() { return {}; } };
      },
    });
    const joining = element('join').onclick();
    await reached.promise;
    const leaving = element('leave').onclick();
    blocked.resolve();
    await Promise.all([joining, leaving]);
    assert.equal(microphones, 0, `microphone opened after leaving during ${pending}`);
    assert.notEqual(document.body.dataset.phase, 'ready');
    assert.equal(element('join').disabled, false);
  }
});

test('microphone permission granted during close stops the acquired stream', async () => {
  const source = await readFile(new URL('../src/matrix/browser.ts', import.meta.url), 'utf8');
  const { code } = await transform(source.slice(source.indexOf('(window as any).sonoraMatrix =')), { loader: 'ts' });
  const permission = Promise.withResolvers<any>();
  const leave = Promise.withResolvers<void>();
  let stops = 0;
  const state = {
    closed: false, finishInitialSync() {},
    context: { state: 'running', createMediaStreamSource() { return { connect() {} }; }, async resume() {}, async close() { this.state = 'closed'; } },
    session: { leave() { return leave.promise; } }, livekit: { async disconnect() {} }, worker: { terminate() {} }, client: { stopClient() {} }, destination: {},
  };
  const window = { sonoraMatrix: undefined as any };
  runInNewContext(code, { window, navigator: { mediaDevices: { getUserMedia() { return permission.promise; } } }, document: { querySelectorAll() { return []; } } });
  window.sonoraMatrix.state = state;
  const opening = window.sonoraMatrix.enableMicrophone().then(() => false, () => true);
  const closing = window.sonoraMatrix.close();
  permission.resolve({ getTracks() { return [{ stop() { stops++; } }]; } });
  const rejected = await opening;
  leave.resolve();
  await closing;
  assert.equal(stops, 1);
  assert.equal(rejected, true);
  assert.equal(state.context.state, 'closed');
});

test('the bot ending a live call releases the microphone and shows a normal hangup', async () => {
  const html = await readFile(new URL('../src/matrix/call.html', import.meta.url), 'utf8');
  const source = html.split('<script type="module">')[1]!.split('</script>')[0]!.replace("import '/browser.js';", '');
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { setAttribute() {} });
    return elements.get(id);
  };
  const document = { getElementById: element, body: { dataset: {} as Record<string, string> } };
  let poll!: () => Promise<void>, closes = 0, leaves = 0;
  runInNewContext(source, {
    window: { sonoraMatrix: { async start() {}, async enableMicrophone() {}, async close() { closes++; } }, addEventListener() {} },
    document, setInterval(callback: () => Promise<void>) { poll = callback; }, navigator: { sendBeacon() {} },
    async fetch(path: string) {
      if (path === '/leave') leaves++;
      return { ok: true, status: path === '/join' || path === '/status' ? 200 : 204, async json() { return { phase: 'closed' }; } };
    },
  });
  element('join').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.body.dataset.phase, 'ready');
  await poll();
  assert.ok(closes > 0); assert.equal(leaves, 1);
  assert.equal(document.body.dataset.phase, 'idle'); assert.equal(element('join').disabled, false);
});
