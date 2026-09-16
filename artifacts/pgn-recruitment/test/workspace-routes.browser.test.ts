import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
};

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (message: CdpMessage) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message);
        return;
      }
      if (!message.method) return;
      this.listeners.get(message.method)?.forEach((listener) => listener(message.params ?? {}));
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Could not connect to Chromium.')), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<CdpMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket.close();
  }
}

async function findFreePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (matches(latest)) return latest;
    } catch {
      // The Vite and Chromium processes need a moment to start listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

async function waitForHttp(url: string) {
  await waitFor(
    async () => fetch(url),
    (response) => response.ok,
    `Vite to serve ${url}`,
  );
}

const appDirectory = new URL('../', import.meta.url);
const routes = [
  { path: '/dashboard', label: 'dashboard' },
  { path: '/voting', label: 'voting' },
  { path: '/pnms/42', label: 'nested PNM profile' },
];

test('direct workspace routes survive browser reload after authentication restores', async (t) => {
  const port = await findFreePort();
  const debugPort = await findFreePort();
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'pgn-browser-test-'));
  const server = spawn('pnpm', ['exec', 'vite', '--config', 'vite.config.ts', '--host', '127.0.0.1'], {
    cwd: appDirectory,
    env: {
      ...process.env,
      BASE_PATH: '/',
      NODE_ENV: 'test',
      PGN_BROWSER_TEST_AUTH: 'true',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const browser = spawn(process.env.CHROMIUM_PATH ?? '/repl/tools/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  t.after(async () => {
    server.kill('SIGTERM');
    browser.kill('SIGTERM');
    await rm(userDataDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/dashboard`);
  const version = await waitFor(
    async () => fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>),
    (value) => Boolean(value.webSocketDebuggerUrl),
    'Chromium DevTools endpoint',
  );
  assert.ok(version.webSocketDebuggerUrl);

  const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json() as Promise<Array<{ type: string; webSocketDebuggerUrl?: string }>>);
  const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'Chromium did not expose a page target.');

  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const browserErrors: string[] = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    browserErrors.push(details?.exception?.description ?? details?.text ?? 'Unknown browser exception');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const details = params.args as Array<{ value?: unknown }> | undefined;
    const values = details?.map((argument) => argument.value).filter((value) => value !== undefined);
    if (values?.length) browserErrors.push(values.map(String).join(' '));
  });

  const waitForLoad = () => new Promise<void>((resolve) => {
    cdp.on('Page.loadEventFired', () => resolve());
  });
  const evaluate = async <T>(expression: string) => {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    return response.result?.result as { value?: T } | undefined;
  };
  const routeState = () => evaluate<{ pathname: string; protected: boolean; loading: boolean; notFound: boolean; body: string }>(`({
    pathname: window.location.pathname,
    protected: Boolean(document.querySelector('[data-testid="protected-route"]')),
    loading: Boolean(document.querySelector('[data-testid="auth-loading-state"]')),
    notFound: Boolean(document.querySelector('[data-testid="route-not-found"]')),
    body: document.body.innerText.slice(0, 400)
  })`).then((result) => result?.value);

  for (const route of routes) {
    const directLoad = waitForLoad();
    await cdp.send('Page.navigate', { url: `${baseUrl}${route.path}` });
    await directLoad;
    const directState = await waitFor(
      routeState,
      (state) => Boolean(state?.protected || state?.notFound),
      `${route.label} authentication restoration${browserErrors.length ? ` (${browserErrors.join('; ')})` : ''}`,
    );
    assert.equal(directState?.pathname, route.path);
    assert.equal(directState?.notFound, false, `${route.path} rendered the route fallback instead of the protected route.`);
    assert.equal(directState?.loading, false, `${route.path} remained in the authentication loading state.`);
    assert.equal(directState?.protected, true, `${route.path} did not render its protected route.`);

    const reload = waitForLoad();
    await cdp.send('Page.reload', { ignoreCache: true });
    await reload;
    const reloadedState = await waitFor(
      routeState,
      (state) => Boolean(state?.protected || state?.notFound),
      `${route.label} after browser reload`,
    );
    assert.equal(reloadedState?.pathname, route.path);
    assert.equal(reloadedState?.notFound, false, `${route.path} rendered the route fallback after reload.`);
    assert.equal(reloadedState?.loading, false, `${route.path} remained in the authentication loading state after reload.`);
    assert.equal(reloadedState?.protected, true, `${route.path} lost its protected route after reload.`);
  }

  cdp.close();
});