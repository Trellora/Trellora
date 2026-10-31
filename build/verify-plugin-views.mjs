import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const root = process.cwd();
const fixture = path.join(root, 'build', 'plugin-view-fixture');
const userData = path.join(fixture, 'user-data');
const workspace = path.join(fixture, 'workspace');
const zipPath = path.resolve(root, '..', 'NoticHubPlugin', 'dist', 'notice-hub-1.1.0.zip');
const pluginId = 'com.expertkt.notice-hub';
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace, appPreferences: { language: 'zh-CN', theme: 'light' } }));
fs.writeFileSync(path.join(userData, 'plugin-permissions.json'), JSON.stringify({ [pluginId]: ['system:file', 'system:network'] }));
const port = await freePort();
const childEnv = { ...process.env, NODE_ENV: 'production' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const electronBinary = path.join(root, 'node_modules', '.pnpm', 'electron@44.7.0', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const child = spawn(electronBinary, ['dist-electron/main.js', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const connections = [];
try {
  const targets = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${logs}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return pages.find(page => page.type === 'page') || null;
    } catch { return null; }
  }, 'Electron debugging target');
  const main = await connect(targets.webSocketDebuggerUrl);
  connections.push(main);
  const evaluate = main.evaluate;
  await main.send('Page.enable');
  await main.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const pluginTab = `([...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent.trim() === '群务台'))`;
  const refresh = `window.dispatchEvent(new Event('trellora:plugins-changed'))`;
  const openPluginView = async () => {
    await waitFor(() => evaluate(`Boolean(${pluginTab})`), 'enabled plugin tab');
    await evaluate(`${pluginTab}.click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('iframe[src^="trellora-plugin://"]'))`), 'plugin iframe');
    const target = await waitFor(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return pages.find(page => page.type === 'iframe' && page.url.startsWith('trellora-plugin://')) || null;
    }, 'sandboxed plugin target');
    const frame = await connect(target.webSocketDebuggerUrl);
    connections.push(frame);
    await waitFor(async () => {
      try { return await frame.evaluate(`document.body.dataset.ready === 'true'`) || null; }
      catch { return null; }
    }, 'plugin backend get-state through postMessage');
    return frame;
  };

  await waitFor(() => evaluate('Boolean(document.querySelector(".window-titlebar") && document.querySelector(".app-nav-rail"))'), 'main layout');
  await evaluate(`window.electronAPI.getOnboardingState().then(state => window.electronAPI.updateOnboardingState({ action: 'defer', expectedRevision: state.revision }))`);
  await waitFor(() => evaluate('!document.querySelector("[data-testid=first-run-guide]")'), 'guide dismissed');
  await evaluate('document.querySelector(".app-nav-item[aria-label=设置]").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(".settings-page"))'), 'settings opened');

  console.log('[verify] install disabled plugin');
  await evaluate(`window.electronAPI.plugin.installFromZip(${JSON.stringify(zipPath)}).then(() => { ${refresh}; })`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await evaluate(`Boolean(${pluginTab})`), false, 'installed but disabled plugin has no settings entry');
  console.log('[verify] enable plugin and render view');
  assert.equal(await evaluate(`window.electronAPI.plugin.enable(${JSON.stringify(pluginId)}).then(result => result.ok)`), true);
  await evaluate(refresh);
  let frame = await openPluginView();
  assert.equal(await evaluate(`document.querySelector('iframe').getAttribute('sandbox')`), 'allow-scripts');
  assert.equal(await frame.evaluate(`document.querySelector('[data-testid="notice-hub-plugin-settings"]') !== null`), true);
  assert.equal(await frame.evaluate(`document.getElementById('token').value`), '');

  console.log('[verify] save plugin-owned configuration');
  await frame.evaluate(`document.getElementById('token').value = 'test-secret-token'; document.getElementById('save').click(); true`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[verify] save result', JSON.stringify(await frame.evaluate(`({ message: document.getElementById('message').textContent, disabled: document.getElementById('save').disabled })`)));
  console.log('[verify] persisted files', fs.existsSync(path.join(userData, 'plugin-secrets.json')), fs.existsSync(path.join(userData, 'plugins', pluginId, '.storage', 'config.json')));
  await waitFor(async () => {
    try { return (await frame.evaluate(`document.getElementById('message').textContent`)) || null; }
    catch { return null; }
  }, 'plugin-owned configuration save');
  assert.equal(await frame.evaluate(`document.getElementById('message').textContent`), '配置已保存。');
  assert.equal(await frame.evaluate(`document.getElementById('token').value`), '', 'token is never echoed back');
  assert.equal(await frame.evaluate(`!document.getElementById('clear-token-row').hidden`), true);
  const secretsRaw = fs.readFileSync(path.join(userData, 'plugin-secrets.json'), 'utf8');
  assert.equal(secretsRaw.includes('test-secret-token'), false, 'secret is encrypted on disk');
  const pluginConfigRaw = fs.readFileSync(path.join(userData, 'plugins', pluginId, '.storage', 'config.json'), 'utf8');
  assert.equal(pluginConfigRaw.includes('token'), false, 'plugin config contains no token');

  const enabledScreenshot = await main.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(fixture, 'plugin-enabled.png'), Buffer.from(enabledScreenshot.data, 'base64'));
  await evaluate(`window.electronAPI.plugin.disable(${JSON.stringify(pluginId)}).then(() => { ${refresh}; })`);
  console.log('[verify] disable plugin and remove view');
  await waitFor(() => evaluate(`!${pluginTab} && !document.querySelector('iframe[src^="trellora-plugin://"]')`) || null, 'disabled plugin view removed');
  assert.equal(await evaluate(`window.electronAPI.plugin.invokeView(${JSON.stringify(pluginId)}, 'settings', 'get-state').then(() => false, error => error.message.includes('插件未启用'))`), true);

  assert.equal(await evaluate(`window.electronAPI.plugin.enable(${JSON.stringify(pluginId)}).then(result => result.ok)`), true);
  await evaluate(refresh);
  frame = await openPluginView();
  assert.equal(await frame.evaluate(`document.getElementById('token').value`), '', 're-render still does not expose token');
  assert.equal(await frame.evaluate(`!document.getElementById('clear-token-row').hidden`), true, 're-render loads saved configuration');
  assert.equal(await evaluate('window.electronAPI.windowControls.toggleMaximized()'), true);
  assert.equal(await evaluate('window.electronAPI.windowControls.toggleMaximized()'), false);
  console.log('[verify] uninstall plugin and remove view');
  await evaluate(`window.electronAPI.plugin.uninstall(${JSON.stringify(pluginId)}).then(() => { ${refresh}; })`);
  await waitFor(() => evaluate(`!${pluginTab} && !document.querySelector('iframe[src^="trellora-plugin://"]')`) || null, 'uninstalled plugin view removed');
  assert.equal(await evaluate(`window.electronAPI.plugin.invokeView(${JSON.stringify(pluginId)}, 'settings', 'get-state').then(() => false, error => error.message.includes('插件未启用'))`), true);
  console.log(JSON.stringify({ ok: true, installedWithoutView: true, enabledView: true, disabledViewRemoved: true, reenabledView: true, uninstalledViewRemoved: true, encryptedSecret: true, screenshot: path.join(fixture, 'plugin-enabled.png') }, null, 2));
  // macOS may keep the application process alive after its final window closes.
  await evaluate('window.electronAPI.windowControls.close()');
} finally {
  for (const connection of connections) connection.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugging connection closed')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Debugging command timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
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
