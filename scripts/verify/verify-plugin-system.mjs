/**
 * Plugin system verification: manifest parsing, permission tiers, registry
 * lifecycle, and the three extension-point registries.
 * 插件系统校验：清单解析、权限层级、注册表生命周期、三大扩展点注册表。
 *
 * Run: node scripts/verify/verify-plugin-system.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = mkdtempSync(path.join(os.tmpdir(), 'verify-plugin-'));
const outFile = path.join(outDir, 'pluginSystem.mjs');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'plugins', 'pluginHost.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  alias: { electron: path.join(rootDir, 'scripts', 'verify', 'electron-stub.mjs') },
});

const { PluginHost } = await import(pathToFileURL(outFile).href);
const manifestMod = await import(pathToFileURL(path.join(outDir, 'pluginSystem.mjs')).href);
// Manifest/permission types are bundled in; re-bundle the manifest parser standalone
const manifestOut = path.join(outDir, 'manifest.mjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'plugins', 'pluginManifest.ts')], outfile: manifestOut, bundle: true, platform: 'node', format: 'esm' });
const { parsePluginManifest } = await import(pathToFileURL(manifestOut).href);

// ── 1. Manifest validation ───────────────────────────────────────────────────

const validManifest = {
  id: 'com.example.test', name: 'Test', version: '1.0.0', main: 'main.js',
  engine: { trellora: '>=1.3.0' }, permissions: ['ui:command', 'ui:view'], activation: ['onStartup'],
  contributes: { views: [{ id: 'settings', title: '测试页面', location: 'settings', entry: 'ui/settings.html' }] },
};
assert.doesNotThrow(() => parsePluginManifest(validManifest));
assert.throws(() => parsePluginManifest({ ...validManifest, contributes: { views: [{ id: 'settings', title: 'Bad', location: 'settings', entry: '../secret.html' }] } }), /相对 HTML 路径/);
assert.throws(() => parsePluginManifest({ ...validManifest, contributes: { views: [{ id: 'settings', title: 'Bad', location: 'sidebar', entry: 'ui/settings.html' }] } }), /仅支持 settings/);

assert.throws(() => parsePluginManifest({ ...validManifest, id: 'Bad!' }), /id 不合法/);
assert.throws(() => parsePluginManifest({ ...validManifest, version: 'x' }), /version 不合法/);
assert.throws(() => parsePluginManifest({ ...validManifest, main: '/abs.js' }), /main 不合法/);
assert.throws(() => parsePluginManifest({ ...validManifest, permissions: ['nope'] }), /未知项/);
assert.throws(() => parsePluginManifest({ ...validManifest, activation: ['nope'] }), /未知项/);
assert.throws(() => parsePluginManifest({ ...validManifest, evil: 1 }), /未知字段/);

// V1.2 配置正式化（契约 §4.8）：manifest settings schema。
const withSettings = parsePluginManifest({
  ...validManifest,
  settings: {
    writeback: { type: 'boolean', default: false, title: '回写' },
    interval: { type: 'number', default: 15, min: 5, max: 240 },
  },
});
assert.equal(withSettings.settings.writeback.default, false, 'settings 默认值解析');
assert.equal(withSettings.settings.interval.max, 240, 'settings min/max 解析');
assert.equal(parsePluginManifest(validManifest).settings, undefined, '无 settings 时为 undefined');
assert.throws(() => parsePluginManifest({ ...validManifest, settings: { bad: { type: 'nope', default: 1 } } }), /type 不合法/);
assert.throws(() => parsePluginManifest({ ...validManifest, settings: { k: { type: 'number', default: 'x' } } }), /不匹配/);
assert.throws(() => parsePluginManifest({ ...validManifest, settings: { 'bad-key': { type: 'boolean', default: true } } }), /键不合法/);
console.log('manifest validation: PASS');

// ── 2. Permission tiers ─────────────────────────────────────────────────────

const permissionOut = path.join(outDir, 'permission.mjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'plugins', 'pluginPermission.ts')], outfile: permissionOut, bundle: true, platform: 'node', format: 'esm' });
const { PluginPermissionManager } = await import(pathToFileURL(permissionOut).href);

const store = { read: () => ({}), write: (s) => { store.written = s; } };
const perms = new PluginPermissionManager(store);
perms.declare('p1', ['ui:command', 'system:file']);
assert.equal(perms.isGranted('p1', 'ui:command'), true, 'L1 declared = granted');
assert.equal(perms.isGranted('p1', 'system:file'), false, 'L2 needs explicit grant');
perms.grant('p1', 'system:file');
assert.equal(perms.isGranted('p1', 'system:file'), true, 'L2 granted after grant');
assert.throws(() => perms.assert('p1', 'system:network'), /权限/);
console.log('permission tiers: PASS');

// ── 3. Registry + lifecycle ─────────────────────────────────────────────────

const pluginsDir = mkdtempSync(path.join(os.tmpdir(), 'verify-plugins-'));
const pluginDir = path.join(pluginsDir, 'com.example.test');
mkdirSync(pluginDir, { recursive: true });
writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(validManifest));
writeFileSync(path.join(pluginDir, 'main.js'), 'module.exports = { activate(ctx) { ctx.log.info("hi"); ctx.ui.registerCommand({ id: "test:cmd", title: "T", execute: () => {} }); ctx.ui.registerViewHandler({ viewId: "settings", invoke: ({ method, params }) => ({ method, params }) }); } };');

const logs = [];
const host = new PluginHost({
  pluginsDir,
  trelloraVersion: '1.3.0',
  permissionStore: { read: () => ({}), write: () => {} },
  onLog: (m) => logs.push(m),
});
host.discover();
assert.equal(host.registry.all().length, 1, 'one plugin discovered');
assert.equal(host.registry.get('com.example.test').state, 'registered');

const activated = await host.activateFor('onStartup');
assert.deepEqual(activated, ['com.example.test'], 'activated on startup');
assert.equal(host.registry.get('com.example.test').state, 'active');
assert.ok(host.getContributions().uiCommands.has('test:cmd'), 'UI command registered');
assert.deepEqual(await host.invokeView('com.example.test', 'settings', { method: 'ping', params: { value: 1 } }), { method: 'ping', params: { value: 1 } }, 'active plugin view invocation');
await assert.rejects(() => host.invokeView('com.example.test', 'missing', { method: 'ping' }), /未知插件页面/);

// Panel binding: sidebar-bound commands surface as sidebar buttons; palette-only ones do not.
const uiCommands = host.getContributions().uiCommands;
const sidebarButtons = [...uiCommands.entries()]
  .filter(([, c]) => (c.panel ?? 'sidebar') === 'sidebar')
  .map(([id, c]) => ({ id, title: c.title }));
assert.deepEqual(sidebarButtons, [{ id: 'test:cmd', title: 'T' }], 'default panel renders in sidebar');
uiCommands.set('test:palette', { pluginId: 'com.example.test', title: 'P', panel: 'command-palette', execute: () => {} });
assert.deepEqual(
  [...uiCommands.entries()].filter(([, c]) => (c.panel ?? 'sidebar') === 'sidebar').map(([id]) => id),
  ['test:cmd'],
  'command-palette commands stay out of the sidebar',
);

// Disable + re-enable
await host.disable('com.example.test');
assert.equal(host.registry.get('com.example.test').state, 'disabled');
assert.equal(host.getContributions().viewHandlers.size, 0, 'disable removes plugin view handlers');
await assert.rejects(() => host.invokeView('com.example.test', 'settings', { method: 'ping' }), /插件未启用/);
await host.activate('com.example.test');
assert.equal(host.registry.get('com.example.test').state, 'active');
assert.equal(host.getContributions().viewHandlers.size, 1, 're-enable registers the view again');
assert.deepEqual(await host.invokeView('com.example.test', 'settings', { method: 'ping' }), { method: 'ping', params: undefined });

// Uninstall
await host.uninstall('com.example.test');
assert.equal(host.registry.all().length, 0, 'uninstalled');
console.log('registry + lifecycle: PASS');

// ── 4. Extension-point registries ───────────────────────────────────────────

const routesOut = path.join(outDir, 'routes.mjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'pipeline', 'routes.ts')], outfile: routesOut, bundle: true, platform: 'node', format: 'esm' });
const { resolveParsingRoute, registerCustomParsingRoute, getCustomParsingRoute, unregisterCustomParsingRoute } = await import(pathToFileURL(routesOut).href);

assert.equal(resolveParsingRoute('.md'), 'direct');
assert.equal(resolveParsingRoute('.epub'), 'unsupported');
registerCustomParsingRoute('.epub', { route: 'epub', handler: async () => ({ markdownFile: 'd.md' }) });
assert.equal(resolveParsingRoute('.epub'), 'custom');
assert.ok(getCustomParsingRoute('.epub'));
assert.throws(() => registerCustomParsingRoute('.pdf', { route: 'x', handler: async () => ({ markdownFile: 'x' }) }), /占用/);
unregisterCustomParsingRoute('.epub');
assert.equal(resolveParsingRoute('.epub'), 'unsupported');
console.log('extension-point registries: PASS');

rmSync(pluginsDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
console.log('verify-plugin-system: ALL PASS');
