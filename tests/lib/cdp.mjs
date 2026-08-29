// Минимальный клиент Chrome DevTools Protocol на встроенном в Node 24 WebSocket.
// Внешних зависимостей нет намеренно: решение человека — автотесты без установок.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].filter(Boolean);

export function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error('Chrome не найден. Укажите путь в переменной окружения CHROME_PATH.');
  return hit;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) { lastError = e; }
    await sleep(150);
  }
  throw new Error(`DevTools на порту ${port} не поднялся за ${timeoutMs} мс: ${lastError}`);
}

export class Browser {
  constructor(proc, ws, userDataDir) {
    this.proc = proc;
    this.ws = ws;
    this.userDataDir = userDataDir;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this.onMessage(JSON.parse(ev.data)));
  }

  static async launch({ port = 9223, width = 1280, height = 800, headless = true } = {}) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'finance-tests-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');
    const proc = spawn(findChrome(), args, { stdio: 'ignore' });
    const info = await waitForDevtools(port);
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket к браузеру не открылся')), { once: true });
    });
    const browser = new Browser(proc, ws, userDataDir);
    browser.version = info.Browser;
    return browser;
  }

  onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
    for (const cb of [...(this.listeners.get(key) || [])]) cb(msg.params);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: нет ответа за 30 с`));
      }, 30000);
    });
  }

  on(event, cb, sessionId) {
    const key = sessionId ? `${sessionId}:${event}` : event;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(cb);
    return () => {
      const arr = this.listeners.get(key) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async close() {
    try { this.ws.close(); } catch { /* уже закрыт */ }
    this.proc.kill();
    await sleep(400);
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = [];      // сообщения консоли за прогон
    this.exceptions = [];   // необработанные исключения
    this.requests = [];     // сетевые запросы страницы
    this.dialogs = [];      // сработавшие window.confirm / alert
    this.dialogAnswer = true;
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }
  on(event, cb) { return this.browser.on(event, cb, this.sessionId); }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    this.on('Runtime.consoleAPICalled', (p) => {
      this.console.push({ type: p.type, text: (p.args || []).map(argToText).join(' ') });
    });
    this.on('Runtime.exceptionThrown', (p) => {
      this.exceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    });
    this.on('Network.requestWillBeSent', (p) => this.requests.push(p.request.url));
    this.on('Page.javascriptDialogOpening', (p) => {
      this.dialogs.push({ type: p.type, message: p.message });
      this.send('Page.handleJavaScriptDialog', { accept: this.dialogAnswer }).catch(() => {});
    });
  }

  /** Скрипт, исполняемый до скриптов страницы при каждой навигации. */
  async addPreload(source) {
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
    return identifier;
  }

  async removePreload(identifier) {
    await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  }

  async waitLoad(action) {
    const loaded = new Promise((resolve) => {
      const off = this.on('Page.loadEventFired', () => { off(); resolve(); });
    });
    await action();
    await loaded;
    await sleep(120); // приложение дорисовывает экран после load
  }

  goto(url) { return this.waitLoad(() => this.send('Page.navigate', { url })); }
  reload() { return this.waitLoad(() => this.send('Page.reload')); }

  /** Выполнить выражение в странице и вернуть значение по JSON. */
  async eval(body) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('Ошибка в странице: ' + (d.exception?.description || d.text));
    }
    return res.result.value;
  }

  setViewport(width, height, mobile = false) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }

  clearViewport() { return this.send('Emulation.clearDeviceMetricsOverride'); }

  emulateColorScheme(value) { // 'light' | 'dark' | null — снять эмуляцию
    return this.send('Emulation.setEmulatedMedia', {
      media: '',
      features: value ? [{ name: 'prefers-color-scheme', value }] : [],
    });
  }

  async setDownloadDir(path) {
    try {
      await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path, eventsEnabled: true });
    } catch {
      await this.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path });
    }
  }

  /** Подсунуть файл в input[type=file] — настоящий импорт, а не подмена функции. */
  async setFileInput(selector, files) {
    await this.send('DOM.enable');
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`Элемент ${selector} не найден`);
    await this.send('DOM.setFileInputFiles', { files, nodeId });
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

function argToText(arg) {
  if (arg.value !== undefined) return String(arg.value);
  if (arg.description) return arg.description;
  return arg.type;
}
