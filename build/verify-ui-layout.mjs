import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const root = process.cwd();
const fixture = path.join(root, 'build', 'ui-layout-fixture');
const userData = path.join(fixture, 'user-data');
const workspace = path.join(fixture, 'workspace');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace, appPreferences: { language: 'zh-CN', theme: 'light' } }));
const port = await freePort();
const childEnv = { ...process.env, NODE_ENV: 'production' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const electronBinary = path.join(root, 'node_modules', '.pnpm', 'electron@44.7.0', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const child = spawn(electronBinary, ['dist-electron/main.js', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let socket;
try {
  const targets = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      return pages.find(page => page.type === 'page') || null;
    } catch { return null; }
  }, 'Electron debugging target');
  socket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate('Boolean(document.querySelector(".window-titlebar") && document.querySelector(".app-nav-rail"))'), 'main layout');
  await evaluate(`window.electronAPI.getOnboardingState().then(state => window.electronAPI.updateOnboardingState({ action: 'defer', expectedRevision: state.revision }))`);
  await waitFor(() => evaluate('!document.querySelector("[data-testid=first-run-guide]")'), 'guide dismissed');
  await evaluate('document.querySelector(".app-nav-item[aria-label=设置]").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".settings-page"))'), 'settings opened');
  await new Promise(resolve => setTimeout(resolve, 500));
  const layout = await evaluate(`(() => {
    const titlebar = document.querySelector('.window-titlebar').getBoundingClientRect();
    const body = document.querySelector('.app-window-body').getBoundingClientRect();
    const rail = document.querySelector('.app-nav-rail').getBoundingClientRect();
    const icon = document.querySelector('.app-nav-item svg').getBoundingClientRect();
    return {
      titlebarTop: titlebar.top, titlebarHeight: titlebar.height, bodyTop: body.top,
      railWidth: rail.width, iconWidth: icon.width,
      noticeHubVisible: [...document.querySelectorAll('[role=tab]')].some(tab => tab.textContent.includes('群务台')),
      settingsTabs: [...document.querySelectorAll('[role=tab]')].map(tab => tab.textContent),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  assert.equal(layout.titlebarTop, 0);
  assert.equal(layout.titlebarHeight, 36);
  assert.equal(layout.bodyTop, 36);
  assert.equal(layout.railWidth, 68);
  assert.equal(layout.iconWidth, 18);
  assert.equal(layout.noticeHubVisible, false);
  assert.equal(layout.horizontalOverflow, false);
  assert.equal(await evaluate('window.electronAPI.windowControls.isMaximized()'), false);
  assert.equal(await evaluate('window.electronAPI.windowControls.toggleMaximized()'), true);
  assert.equal(await evaluate('window.electronAPI.windowControls.toggleMaximized()'), false);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(fixture, 'settings.png'), Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ ok: true, layout, screenshot: path.join(fixture, 'settings.png') }, null, 2));
  await evaluate('window.electronAPI.windowControls.close()');
  await waitFor(() => child.exitCode !== null ? true : null, 'window close');
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function waitFor(action, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
