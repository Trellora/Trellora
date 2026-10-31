/**
 * Plugin installer verification: URL validation, download transport errors
 * (the historic `TypeError: fetch failed` class), zip staging + traversal
 * guards, manifest validation on install, and atomic upgrade overwrite.
 * 插件安装器校验：URL 校验、下载传输层错误（历史上以 `TypeError: fetch failed`
 * 形式暴露的一类）、zip 暂存与路径穿越防护、安装期清单校验、升级时原子覆盖。
 *
 * Run: node scripts/verify/verify-plugin-installer.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = mkdtempSync(path.join(os.tmpdir(), 'verify-plugin-installer-'));

/** Bundle one entry with a stubbed `electron.net` that replays scripted outcomes. */
async function bundleWithNet(entryRel, netStubSource) {
  const netStub = path.join(outDir, `net-stub-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(netStub, netStubSource, 'utf8');
  const outFile = path.join(outDir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [path.join(rootDir, entryRel)],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { electron: netStub },
  });
  return import(pathToFileURL(outFile).href);
}

const bundleInstallerWithNet = (stub) => bundleWithNet('electron/plugins/pluginInstaller.ts', stub);
const bundleDownloaderWithNet = (stub) => bundleWithNet('electron/plugins/pluginDownload.ts', stub);

/** Minimal fake `net.request` that serves a scripted body or error. */
function netStubServing({ body, status = 200, error, redirectTo }) {
  return `
    export const net = {
      request(opts) {
        const handlers = {};
        return {
          on(name, fn) { handlers[name] = fn; },
          abort() {},
          end() {
            setImmediate(() => {
              if (${JSON.stringify(redirectTo)}) {
                handlers.redirect && handlers.redirect(302, 'GET', ${JSON.stringify(redirectTo ?? '')});
                return;
              }
              if (${JSON.stringify(error ?? null)}) {
                handlers.error && handlers.error(new Error(${JSON.stringify(error ?? '')}));
                return;
              }
              handlers.response && handlers.response({
                statusCode: ${status},
                on(name, fn) {
                  if (name === 'data') setImmediate(() => fn(Buffer.from(${JSON.stringify(body ?? '')}, 'utf8')));
                  if (name === 'end') setImmediate(() => fn());
                },
              });
            });
          },
        };
      },
    };
    export default { net };
  `;
}

// ── 1. URL policy (https only, no credentials) ───────────────────────────────

{
  const { downloadToFile } = await bundleDownloaderWithNet(netStubServing({ body: 'x' }));
  await assert.rejects(() => downloadToFile('http://example.com/p.zip', path.join(outDir, 'a.zip')), /仅支持 https/);
  await assert.rejects(() => downloadToFile('https://user:pass@example.com/p.zip', path.join(outDir, 'b.zip')), /账号信息/);
  console.log('url policy: PASS');
}

// ── 2. Transport errors surface cause + actionable hint (regression: fetch failed) ──

{
  const { downloadToFile } = await bundleDownloaderWithNet(netStubServing({ error: 'socket hang up' }));
  await assert.rejects(
    () => downloadToFile('https://example.com/p.zip', path.join(outDir, 'c.zip')),
    (error) => {
      assert.match(error.message, /插件下载失败/u, 'classified as a plugin download failure');
      assert.match(error.message, /代理|网络/u, 'carries an actionable hint');
      assert.doesNotMatch(error.message, /fetch failed/u, 'no bare fetch failed leaks to the user');
      return true;
    },
  );
  console.log('transport error hint: PASS');
}

// ── 3. HTTP status errors are specific ───────────────────────────────────────

{
  const { downloadToFile } = await bundleDownloaderWithNet(netStubServing({ body: 'missing', status: 404 }));
  await assert.rejects(
    () => downloadToFile('https://example.com/p.zip', path.join(outDir, 'd.zip')),
    /HTTP 404/u,
  );
  console.log('http status error: PASS');
}

// ── 4. Successful download writes the final file, never a partial ────────────

{
  const dest = path.join(outDir, 'ok.zip');
  const { downloadToFile } = await bundleDownloaderWithNet(netStubServing({ body: 'PK\u0003\u0004-payload' }));
  await downloadToFile('https://example.com/p.zip', dest);
  assert.equal(readFileSync(dest, 'utf8'), 'PK\u0003\u0004-payload', 'body written verbatim');
  assert.equal(existsSync(`${dest}.part`), false, 'no partial file left behind');
  console.log('successful download: PASS');
}

// ── 5. installPluginFromZip: traversal guard + manifest validation ───────────

function makeZip(dir, files) {
  // Build a real zip via Python's zipfile so the reader under test sees genuine
  // central-directory offsets. `files` maps name -> string content; names are
  // used verbatim, which is how the traversal-guard case plants `../escape.js`.
  // 用 Python zipfile 生成真实压缩包（名字按原样写入，路径穿越用例借此植入 `../escape.js`）。
  const staging = mkdtempSync(path.join(os.tmpdir(), 'verify-plugin-src-'));
  const payload = {};
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(staging, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    payload[name] = content;
  }
  const zipPath = path.join(dir, `pkg-${Math.random().toString(36).slice(2)}.zip`);
  execFileSync('python3', ['-c', `
import sys, json, zipfile
out, payload_src = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w') as z:
    for name, content in json.loads(payload_src).items():
        z.writestr(name, content)
  `, zipPath, JSON.stringify(payload)]);
  rmSync(staging, { recursive: true, force: true });
  return zipPath;
}

{
  const { installPluginFromZip } = await bundleInstallerWithNet(netStubServing({ body: '' }));
  const pluginsDir = path.join(outDir, 'plugins-ok');
  const zip = makeZip(outDir, {
    'plugin.json': JSON.stringify({
      id: 'com.example.demo', name: 'Demo', version: '1.0.0', main: 'main.js',
      engine: { trellora: '>=1.3.0' }, permissions: ['ui:command'], activation: ['onStartup'],
    }),
    'main.js': 'module.exports = {};',
  });
  const { manifest, pluginDir } = await installPluginFromZip(zip, pluginsDir);
  assert.equal(manifest.id, 'com.example.demo');
  assert.ok(existsSync(path.join(pluginDir, 'main.js')), 'entry installed');

  // Upgrade: same id, new version replaces the directory atomically.
  const zip2 = makeZip(outDir, {
    'plugin.json': JSON.stringify({
      id: 'com.example.demo', name: 'Demo', version: '2.0.0', main: 'main.js',
      engine: { trellora: '>=1.3.0' }, permissions: ['ui:command'], activation: ['onStartup'],
    }),
    'main.js': 'module.exports = { v: 2 };',
  });
  const up = await installPluginFromZip(zip2, pluginsDir);
  assert.equal(up.manifest.version, '2.0.0');
  assert.match(readFileSync(path.join(up.pluginDir, 'main.js'), 'utf8'), /v: 2/u, 'upgraded content in place');
  assert.equal(readdirSync(pluginsDir).length, 1, 'single install directory after upgrade');
  console.log('zip install + upgrade: PASS');
}

{
  const { installPluginFromZip } = await bundleInstallerWithNet(netStubServing({ body: '' }));
  const pluginsDir = path.join(outDir, 'plugins-evil');
  const zip = makeZip(outDir, {
    'plugin.json': JSON.stringify({
      id: 'com.example.evil', name: 'E', version: '1.0.0', main: 'main.js',
      engine: { trellora: '>=1.3.0' }, permissions: ['ui:command'], activation: ['onStartup'],
    }),
    '../escape.js': 'nope',
    'main.js': 'module.exports = {};',
  });
  await assert.rejects(() => installPluginFromZip(zip, pluginsDir), /非法路径|无法读取/u);
  assert.equal(existsSync(pluginsDir) && readdirSync(pluginsDir).length > 0, false, 'malformed package never lands');
  console.log('traversal guard: PASS');
}

{
  const { installPluginFromZip } = await bundleInstallerWithNet(netStubServing({ body: '' }));
  const pluginsDir = path.join(outDir, 'plugins-badzip');
  const junk = path.join(outDir, 'not-a-zip.zip');
  writeFileSync(junk, 'this is not a zip');
  await assert.rejects(() => installPluginFromZip(junk, pluginsDir), /不是有效的 ZIP 文件/u);
  console.log('non-zip payload: PASS');
}

rmSync(outDir, { recursive: true, force: true });
console.log('verify-plugin-installer: ALL PASS');
