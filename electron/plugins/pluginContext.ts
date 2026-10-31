/**
 * PluginContext builder: assembles the L0/L1/L2 API surface handed to a
 * plugin's activate(). Capability APIs are guarded by the permission manager.
 * 插件上下文装配器：构建 activate() 收到的 L0/L1/L2 API 面。
 * 能力 API 经权限管理器守卫。
 */

import type { PluginPermissionManager } from './pluginPermission.ts';
import type {
  PluginAiGenerationInput, PluginAiGenerationOutput,
  PluginContext, PluginParseInput, PluginParseOutput, PluginPermission,
  PluginScheduleApi, PluginUiCommandArgs,
} from './pluginTypes.ts';
import fs from 'node:fs';
import path from 'node:path';
import { registerCustomParsingRoute } from '../pipeline/routes.ts';
import { parsePluginServiceUrl } from '../websearch/webFetchClient.ts';
import { registerPluginAiProvider } from '../knowledge/ai/pluginAiProviders.ts';

/** Contribution registries the host exposes to plugins. */
export interface ContributionSink {
  parsingRoutes: Map<string, { pluginId: string; route: string; handler: (input: PluginParseInput) => Promise<PluginParseOutput> }>;
  aiProviders: Map<string, { pluginId: string; api: string; endpoint: string; generate: (input: PluginAiGenerationInput) => Promise<PluginAiGenerationOutput> }>;
  uiCommands: Map<string, { pluginId: string; title: string; panel?: string; execute: (args: PluginUiCommandArgs) => void | Promise<void> }>;
  viewHandlers: Map<string, { pluginId: string; viewId: string; invoke: (request: { method: string; params?: unknown }) => unknown | Promise<unknown> }>;
}

export interface PluginContextOptions {
  pluginId: string;
  manifest: unknown;
  storageDir: string;
  permissions: PluginPermissionManager;
  sink: ContributionSink;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  emitEvent: (event: string, payload: unknown) => void;
  subscribe: (event: string, listener: (payload: unknown) => void) => () => void;
  /** 日程扩展点的宿主实现（未接入时为 undefined，调用即抛可操作错误）。 */
  schedule?: PluginScheduleApi;
  /** V1.2 配置正式化（契约 §4.8）：manifest settings 默认值 + 用户覆盖的合并值。 */
  configValues?: Record<string, unknown>;
  secretStore?: {
    get: (pluginId: string, key: string) => Promise<string>;
    set: (pluginId: string, key: string, value: string) => Promise<void>;
    delete: (pluginId: string, key: string) => Promise<void>;
  };
}

/**
 * Builds the runtime context for one plugin. Every L1/L2 sub-API asserts the
 * corresponding permission before touching the host.
 * 构建单个插件的运行时上下文。L1/L2 子 API 在触达宿主前先校验权限。
 */
export function buildPluginContext(options: PluginContextOptions): PluginContext {
  const { pluginId, permissions, sink, onLog, emitEvent, subscribe, storageDir } = options;
  const scheduleApi = options.schedule;

  const guard = (permission: PluginPermission): void => {
    permissions.assert(pluginId, permission);
  };

  const log = {
    info: (message: string, ...args: unknown[]) => onLog('info', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
    warn: (message: string, ...args: unknown[]) => onLog('warn', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
    error: (message: string, ...args: unknown[]) => onLog('error', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
  };

  const events = {
    on: (event: string, listener: (payload: unknown) => void) => subscribe(event, listener),
    once: (event: string, listener: (payload: unknown) => void) => {
      const off = subscribe(event, (payload) => { off(); listener(payload); });
      return off;
    },
    off: (_event: string, _listener: (payload: unknown) => void) => { /* handled by the returned off() */ },
    emit: (event: string, payload: unknown) => emitEvent(event, payload),
  };

  const context: PluginContext = {
    manifest: options.manifest as PluginContext['manifest'],
    storageDir: options.storageDir,
    log,
    config: (() => {
      // V1.2 配置正式化（契约 §4.8）：读 manifest settings 声明键的合并值
      // （用户覆盖 → manifest default），未声明键永远回退 fallback。
      const values = options.configValues ?? {};
      const manifestSettings = ((options.manifest ?? {}) as { settings?: Record<string, unknown> }).settings ?? {};
      return {
        get: <T = unknown>(key: string, fallback?: T): T => {
          if (!(key in manifestSettings)) return fallback as T;
          return (key in values ? values[key] : fallback) as T;
        },
        has: (key: string) => key in manifestSettings,
        keys: () => Object.keys(manifestSettings),
      };
    })(),
    events,
    pipeline: {
      registerParsingRoute: (contribution) => {
        guard('pipeline:parse');
        if (sink.parsingRoutes.has(contribution.extension)) {
          throw new Error(`解析路由扩展名 ${contribution.extension} 已被占用。`);
        }
        // Wire into the real pipeline route table so pipelineOrchestrator/pathLayout
        // see the plugin extension as a first-class route.
        // 接入真实流水线路由表，使 pipelineOrchestrator/pathLayout 把插件扩展名
        // 作为一等解析路由。
        registerCustomParsingRoute(contribution.extension, {
          route: contribution.route,
          handler: contribution.handler as never,
        });
        sink.parsingRoutes.set(contribution.extension, { pluginId, route: contribution.route, handler: contribution.handler });
      },
    },
    ai: {
      registerProvider: (contribution) => {
        guard('ai:provider');
        if (sink.aiProviders.has(contribution.id)) throw new Error(`AI Provider ${contribution.id} 已被占用。`);
        registerPluginAiProvider({
          id: contribution.id,
          api: contribution.api,
          endpoint: contribution.endpoint,
          generate: contribution.generate as never,
          listModels: contribution.listModels as never,
        });
        sink.aiProviders.set(contribution.id, { pluginId, api: contribution.api, endpoint: contribution.endpoint, generate: contribution.generate });
      },
    },
    ui: {
      registerCommand: (contribution) => {
        guard('ui:command');
        if (sink.uiCommands.has(contribution.id)) throw new Error(`UI 命令 ${contribution.id} 已被占用。`);
        sink.uiCommands.set(contribution.id, { pluginId, title: contribution.title, panel: contribution.panel, execute: contribution.execute });
      },
      registerViewHandler: (contribution) => {
        guard('ui:view');
        const declared = (options.manifest as PluginContext['manifest']).contributes?.views?.some((view) => view.id === contribution.viewId);
        if (!declared) throw new Error(`插件页面 ${contribution.viewId} 未在 manifest contributes.views 中声明。`);
        const key = `${pluginId}:${contribution.viewId}`;
        if (sink.viewHandlers.has(key)) throw new Error(`UI 页面处理器 ${key} 已被占用。`);
        sink.viewHandlers.set(key, { pluginId, viewId: contribution.viewId, invoke: contribution.invoke });
      },
    },
    secrets: {
      get: async (key) => {
        guard('system:file');
        assertSecretKey(key);
        if (!options.secretStore) throw new Error('宿主未提供安全密钥存储。');
        return options.secretStore.get(pluginId, key);
      },
      set: async (key, value) => {
        guard('system:file');
        assertSecretKey(key);
        if (typeof value !== 'string') throw new Error('密钥内容必须是字符串。');
        if (!options.secretStore) throw new Error('宿主未提供安全密钥存储。');
        await options.secretStore.set(pluginId, key, value);
      },
      delete: async (key) => {
        guard('system:file');
        assertSecretKey(key);
        await options.secretStore?.delete(pluginId, key);
      },
    },
    data: {
      registerDataSource: (contribution) => {
        guard('data:source');
        onLog('info', `data source ${contribution.id} registered (kind=${contribution.kind})`);
      },
    },
    files: {
      // Bounded to the plugin's own storageDir (rootDir/.storage). Paths are
      // resolved and asserted to stay inside it, blocking traversal outside.
      // 限定在插件自身 storageDir（rootDir/.storage）内。路径解析后断言留在其中，
      // 阻止越界访问。
      readFile: async (relativePath: string) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        return new Uint8Array(await fs.promises.readFile(abs));
      },
      writeFile: async (relativePath: string, data: Uint8Array) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, data);
      },
      listDir: async (relativePath: string) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        return (await fs.promises.readdir(abs, { withFileTypes: true })).map((e) => e.name);
      },
    },
    schedule: {
      // 日程扩展点（契约 §4.1）：L1 schedule:write 守卫；幂等 upsert 由宿主
      // ScheduleService 按 (source, externalId) 映射实现，插件不接触 SQLite。
      upsertItems: (source, items) => {
        guard('schedule:write');
        if (!scheduleApi) throw new Error('宿主未接入日程扩展点（schedule）。');
        return scheduleApi.upsertItems(source, items);
      },
      removeItems: (source, externalIds) => {
        guard('schedule:write');
        if (!scheduleApi) throw new Error('宿主未接入日程扩展点（schedule）。');
        return scheduleApi.removeItems(source, externalIds);
      },
      listSource: (source) => {
        guard('schedule:write');
        if (!scheduleApi) throw new Error('宿主未接入日程扩展点（schedule）。');
        return scheduleApi.listSource(source);
      },
    },
    network: {
      // 出站 HTTP 限定（契约 §4.2）：公共 https + 环回 http（127.0.0.0/8、::1、
      // localhost、*.localhost），内网/链路本地/凭据 URL 继续拒绝（parsePluginServiceUrl）。
      // redirect 'manual' 不跟随重定向，杜绝环回→内网跳转绕检。
      fetch: async (url: string, init?: RequestInit) => {
        guard('system:network');
        const parsed = parsePluginServiceUrl(url);
        return globalThis.fetch(parsed.href, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(PLUGIN_NETWORK_TIMEOUT_MS) });
      },
    },
  };

  return context;
}

const PLUGIN_NETWORK_TIMEOUT_MS = 10_000;

/**
 * Resolves a relative path under the plugin storage root and asserts the
 * result stays inside it, blocking ../ traversal and absolute paths.
 * 解析插件存储根下的相对路径并断言结果留在其内，阻止 ../ 越界与绝对路径。
 */
function assertSecretKey(key: string): void {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(key)) throw new Error('密钥名称须为 1-128 位字母、数字、点、下划线或连字符。');
}

function safePluginPath(storageDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('插件文件路径必须是非空相对路径。');
  }
  const root = path.resolve(storageDir);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`插件文件路径越界：${relativePath}`);
  }
  return abs;
}
