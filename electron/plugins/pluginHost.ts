/**
 * PluginHost: orchestrates discovery, lifecycle, and contribution dispatch.
 * 插件宿主：编排发现、生命周期与贡献点分发。
 *
 * Lifecycle: discover → registered → activate → active ⇄ disabled → uninstall
 * 生命周期：发现 → 已注册 → 激活 → 运行 ⇄ 禁用 → 卸载
 */

import path from 'node:path';
import { buildPluginContext, type ContributionSink } from './pluginContext.ts';
import { unregisterCustomParsingRoute } from '../pipeline/routes.ts';
import { unregisterPluginAiProvider } from '../knowledge/ai/pluginAiProviders.ts';
import { PluginLoader, type PluginLoaderOptions } from './pluginLoader.ts';
import { PluginPermissionManager, type PermissionStore } from './pluginPermission.ts';
import { PluginRegistry } from './pluginRegistry.ts';
import type { PluginActivationEvent, PluginScheduleApi } from './pluginTypes.ts';

const PLUGIN_TIMEOUT_MS = 5_000;

export interface PluginHostOptions {
  pluginsDir: string;
  trelloraVersion: string;
  permissionStore: PermissionStore;
  onLog?: (message: string) => void;
  /** Prompt for L2 authorization; return true to grant, false to refuse. */
  onRequestL2Authorization?: (manifest: { id: string; name: string; version: string }, permissions: string[]) => Promise<boolean>;
  /** 日程扩展点宿主实现（ScheduleService 适配器，契约 §4.1）。 */
  schedule?: PluginScheduleApi;
  /** V1.2 配置正式化（契约 §4.8）：用户覆盖持久化（plugin-settings.json）。 */
  settingsStore?: {
    read: () => Record<string, Record<string, unknown>>;
    write: (state: Record<string, Record<string, unknown>>) => void;
  };
  /** Host-encrypted secret storage, partitioned by plugin id and key. */
  secretStore?: {
    get: (pluginId: string, key: string) => Promise<string>;
    set: (pluginId: string, key: string, value: string) => Promise<void>;
    delete: (pluginId: string, key: string) => Promise<void>;
  };
}

export class PluginHost {
  readonly registry = new PluginRegistry();
  readonly permissions: PluginPermissionManager;
  private readonly loader: PluginLoader;
  private readonly sink: ContributionSink = {
    parsingRoutes: new Map(),
    aiProviders: new Map(),
    uiCommands: new Map(),
    viewHandlers: new Map(),
  };
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly options: PluginHostOptions) {
    this.permissions = new PluginPermissionManager(options.permissionStore);
    this.loader = new PluginLoader({
      pluginsDir: options.pluginsDir,
      permissions: this.permissions,
      registry: this.registry,
      trelloraVersion: options.trelloraVersion,
      onLog: options.onLog,
    } satisfies PluginLoaderOptions);
  }

  /** Scans the plugin directory and registers all valid plugins. */
  discover(): void {
    this.loader.discover();
  }

  /** Activates plugins that request the given event. Returns activated ids. */
  async activateFor(event: PluginActivationEvent): Promise<string[]> {
    const ids = this.loader.idsForActivation(event);
    const activated: string[] = [];
    for (const id of ids) {
      const ok = await this.activate(id);
      if (ok) activated.push(id);
    }
    return activated;
  }

  /** Activates one plugin (idempotent). Returns true on success. */
  async activate(id: string): Promise<boolean> {
    const plugin = this.registry.get(id);
    if (!plugin) return false;
    if (plugin.state === 'active') return true;

    // L2 permissions require explicit user authorization before activation.
    // L2 权限在激活前需要用户显式授权。
    const l2Needed = plugin.manifest.permissions.filter((p) => p.startsWith('system:') && !this.permissions.isGranted(id, p));
    if (l2Needed.length > 0 && this.options.onRequestL2Authorization) {
      const granted = await this.options.onRequestL2Authorization(plugin.manifest, l2Needed);
      if (!granted) {
        this.registry.setState(id, 'disabled', new Error('用户拒绝了 L2 系统权限。'));
        this.options.onLog?.(`[PLUGIN] ${id} 未激活：用户拒绝 L2 权限。`);
        return false;
      }
      for (const perm of l2Needed) this.permissions.grant(id, perm);
    }

    try {
      const entry = await this.loader.loadEntryFor(plugin);
      const context = buildPluginContext({
        pluginId: id,
        manifest: plugin.manifest,
        storageDir: path.join(plugin.rootDir, '.storage'),
        permissions: this.permissions,
        sink: this.sink,
        onLog: (level, message) => this.options.onLog?.(`[PLUGIN:${id}] ${level}: ${message}`),
        emitEvent: (event, payload) => this.emit(event, payload),
        subscribe: (event, listener) => this.subscribe(event, listener),
        schedule: this.options.schedule,
        configValues: this.resolveSettings(plugin.manifest),
        secretStore: this.options.secretStore,
      });

      await this.withTimeout(entry.activate(context), `activate(${id})`);
      this.registry.setState(id, 'active');
      this.options.onLog?.(`[PLUGIN] 已激活 ${id}`);
      return true;
    } catch (error) {
      this.registry.setState(id, 'error', error as Error);
      this.options.onLog?.(`[PLUGIN] 激活 ${id} 失败：${(error as Error).message}`);
      return false;
    }
  }

  /** Disables an active plugin (runs deactivate if present and drops its contributions). */
  async disable(id: string): Promise<void> {
    const plugin = this.registry.get(id);
    if (!plugin || plugin.state !== 'active') return;
    try {
      if (plugin.entry?.deactivate) {
        await this.withTimeout(plugin.entry.deactivate(), `deactivate(${id})`);
      }
      this.dropContributions(id);
      this.registry.setState(id, 'disabled');
    } catch (error) {
      this.registry.setState(id, 'error', error as Error);
    }
  }

  /** Removes every contribution a plugin registered, so it can be re-activated. */
  private dropContributions(id: string): void {
    for (const [ext, route] of this.sink.parsingRoutes) {
      if (route.pluginId === id) { this.sink.parsingRoutes.delete(ext); unregisterCustomParsingRoute(ext); }
    }
    for (const [pid, provider] of this.sink.aiProviders) {
      if (provider.pluginId === id) { this.sink.aiProviders.delete(pid); unregisterPluginAiProvider(pid); }
    }
    for (const [cid, command] of this.sink.uiCommands) {
      if (command.pluginId === id) this.sink.uiCommands.delete(cid);
    }
    for (const [key, handler] of this.sink.viewHandlers) {
      if (handler.pluginId === id) this.sink.viewHandlers.delete(key);
    }
  }

  /** Uninstalls a plugin: deactivates, removes registry entry and permissions. */
  async uninstall(id: string): Promise<void> {
    await this.disable(id);
    this.registry.remove(id);
    this.permissions.forget(id);
    this.options.onLog?.(`[PLUGIN] 已卸载 ${id}`);
  }

  /** L1 dispatch helpers used by the host's extension points. */
  getContributions(): ContributionSink {
    return this.sink;
  }

  /** Dispatches a sandboxed view request only while its plugin and handler are active. */
  async invokeView(pluginId: string, viewId: string, request: { method: string; params?: unknown }): Promise<unknown> {
    const plugin = this.registry.get(pluginId);
    if (!plugin || plugin.state !== 'active') throw new Error('插件未启用，页面请求已停止。');
    if (!plugin.manifest.contributes?.views?.some((view) => view.id === viewId)) throw new Error(`未知插件页面：${viewId}`);
    const handler = this.sink.viewHandlers.get(`${pluginId}:${viewId}`);
    if (!handler) throw new Error('插件页面尚未就绪，请重新启用插件后重试。');
    return handler.invoke(request);
  }

  /**
   * V1.2 配置正式化（契约 §4.8）：合并用户覆盖与 manifest settings 默认值。
   * 只接受 manifest 声明的键；类型不符的覆盖值丢弃并回退默认。
   */
  private resolveSettings(manifest: { settings?: Record<string, { type: string; default: unknown; min?: number; max?: number }> }): Record<string, unknown> {
    const specs = manifest.settings ?? {};
    const overrides = (this.options.settingsStore?.read() ?? {})[manifestIdOf(manifest)] ?? {};
    const values: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(specs)) {
      const raw = key in overrides ? overrides[key] : spec.default;
      values[key] = coerceSettingValue(key, raw, spec) ?? spec.default;
    }
    return values;
  }

  /** 读取插件的合并配置值（用户覆盖 → manifest default）。 */
  getSettings(id: string): Record<string, unknown> {
    const plugin = this.registry.get(id);
    if (!plugin) return {};
    return this.resolveSettings(plugin.manifest);
  }

  /**
   * 写入用户覆盖并持久化（契约 §4.8）：仅 manifest 声明的键可写，逐键类型校验，
   * 任一非法即抛中文可操作错误且不落盘。
   */
  setSettings(id: string, values: unknown): Record<string, unknown> {
    const plugin = this.registry.get(id);
    if (!plugin) throw new Error(`未知插件：${id}`);
    const specs = plugin.manifest.settings ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('配置内容无效：应为包含配置键的对象。');
    }
    const incoming = values as Record<string, unknown>;
    const state = this.options.settingsStore?.read() ?? {};
    const current = { ...(state[id] ?? {}) };
    for (const [key, raw] of Object.entries(incoming)) {
      const spec = specs[key];
      if (!spec) throw new Error(`插件 ${id} 未声明配置键：${key}。`);
      const coerced = coerceSettingValue(key, raw, spec);
      if (coerced === undefined) throw new Error(`配置 ${key} 的值类型不合法（应为 ${spec.type}）。`);
      current[key] = coerced;
    }
    state[id] = current;
    this.options.settingsStore?.write(state);
    return this.resolveSettings(plugin.manifest);
  }

  /** Event bus (host + plugins share one bus). */
  subscribe(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => set!.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try { listener(payload); } catch { /* listener errors never break the bus */ }
    }
  }

  /** Per-call timeout guard so a hung plugin cannot block the host. */
  private async withTimeout(promise: Promise<void> | void, label: string): Promise<void> {
    if (!(promise instanceof Promise)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 超时（${PLUGIN_TIMEOUT_MS}ms）`)), PLUGIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}


/** 从 manifest 对象取插件 id（resolveSettings 内部用）。 */
function manifestIdOf(manifest: { id?: string }): string {
  return typeof manifest.id === 'string' ? manifest.id : '';
}

/** 单键类型强转（契约 §4.8）：合法返回值，非法返回 undefined。 */
function coerceSettingValue(key: string, raw: unknown, spec: { type: string; min?: number; max?: number }): unknown {
  if (spec.type === 'string') return typeof raw === 'string' ? raw : undefined;
  if (spec.type === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (!Number.isFinite(n)) return undefined;
    const lo = typeof spec.min === 'number' ? spec.min : -Infinity;
    const hi = typeof spec.max === 'number' ? spec.max : Infinity;
    return Math.min(hi, Math.max(lo, n));
  }
  if (spec.type === 'string[]') {
    return Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? raw : undefined;
  }
  return undefined;
}
