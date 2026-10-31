/**
 * Plugin manifest parser and validator.
 * 插件清单解析与校验。
 *
 * Mirrors the checks in scripts/validate-plugin-manifest.mjs so the host
 * rejects the same malformed manifests at runtime.
 *
 * 与 scripts/validate-plugin-manifest.mjs 同构，宿主在运行时拒绝同一类非法清单。
 */

import type { PluginActivationEvent, PluginManifest, PluginPermission } from './pluginTypes.ts';

const PERMISSIONS: readonly PluginPermission[] = [
  'pipeline:parse', 'ai:provider', 'ui:command', 'ui:view', 'data:source', 'schedule:write',
  'system:file', 'system:network', 'system:subprocess',
];
const ACTIVATION_EVENTS: readonly PluginActivationEvent[] = [
  'onStartup', 'onParseRequest', 'onAiRequest', 'onUiCommand', '*',
];

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const MAIN_RE = /^[^/\\].*\.(js|mjs|cjs)$/;

/**
 * Parses and validates a plugin.json object. Throws on the first structural
 * violation; returns a normalized manifest.
 * 解析并校验 plugin.json 对象。结构性违规时抛错；返回规范化的清单。
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plugin.json 必须是 JSON 对象。');
  }
  const value = raw as Record<string, unknown>;

  const id = requireString(value, 'id');
  if (!ID_RE.test(id)) throw new Error(`plugin.json id 不合法：${id}（须为反向 DNS，如 com.example.my-plugin）。`);
  if (id.length < 3 || id.length > 128) throw new Error('plugin.json id 长度须在 3-128 之间。');

  const name = requireString(value, 'name');
  if (name.length < 1 || name.length > 64) throw new Error('plugin.json name 长度须在 1-64 之间。');

  const version = requireString(value, 'version');
  if (!VERSION_RE.test(version)) throw new Error(`plugin.json version 不合法：${version}（须为 semver，如 1.0.0）。`);

  const main = requireString(value, 'main');
  if (!MAIN_RE.test(main)) throw new Error(`plugin.json main 不合法：${main}（须为相对路径的 .js/.mjs/.cjs 文件，禁止绝对路径）。`);
  if (main.length > 256) throw new Error('plugin.json main 长度不得超过 256。');

  const engine = value.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) throw new Error('plugin.json engine 必须是对象。');
  const trelloraRange = (engine as Record<string, unknown>).trellora;
  if (typeof trelloraRange !== 'string' || trelloraRange.length < 1 || trelloraRange.length > 64) {
    throw new Error('plugin.json engine.trellora 必须是 1-64 字符的 semver range 字符串。');
  }

  const permissions = requireArray(value, 'permissions');
  const seenPermissions = new Set<PluginPermission>();
  for (const p of permissions) {
    if (typeof p !== 'string' || !PERMISSIONS.includes(p as PluginPermission)) {
      throw new Error(`plugin.json permissions 含未知项：${String(p)}。`);
    }
    if (seenPermissions.has(p as PluginPermission)) throw new Error(`plugin.json permissions 重复：${p}。`);
    seenPermissions.add(p as PluginPermission);
  }

  const activation = requireArray(value, 'activation');
  const seenActivation = new Set<PluginActivationEvent>();
  for (const e of activation) {
    if (typeof e !== 'string' || !ACTIVATION_EVENTS.includes(e as PluginActivationEvent)) {
      throw new Error(`plugin.json activation 含未知项：${String(e)}。`);
    }
    if (seenActivation.has(e as PluginActivationEvent)) throw new Error(`plugin.json activation 重复：${e}。`);
    seenActivation.add(e as PluginActivationEvent);
  }

  // Reject unknown top-level keys (matches the schema's additionalProperties: false).
  // 拒绝未知顶层键（与 schema 的 additionalProperties: false 对应）。
  const known = new Set(['id', 'name', 'version', 'description', 'author', 'license', 'main', 'engine', 'permissions', 'activation', 'settings', 'contributes']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`plugin.json 含未知字段：${key}。`);
  }

  return {
    id,
    name,
    version,
    description: optionalString(value, 'description', 512),
    author: optionalString(value, 'author', 128),
    license: optionalString(value, 'license', 64),
    main,
    engine: { trellora: trelloraRange },
    permissions: permissions as PluginPermission[],
    activation: activation as PluginActivationEvent[],
    settings: parseSettings(value.settings),
    contributes: parseContributions(value.contributes),
  };
}

const PANELS = new Set(['sidebar', 'command-palette', 'toolbar']);
const AI_APIS = new Set([
  'ollama-chat', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generate-content',
]);
const PARSING_ROUTE_EXT_RE = /^\.[a-z0-9]+$/;
const AI_PROVIDER_ID_RE = /^[a-z0-9-]+$/;
const UI_COMMAND_ID_RE = /^[a-z0-9:-]+$/;

/**
 * Structurally validates `contributes` (mirrors plugins/sdk/plugin.schema.json's
 * contributes subtree, including additionalProperties:false and per-field
 * pattern/length/enum bounds). A malformed contribution is rejected at
 * discovery time instead of failing later inside registerCommand/UI wiring.
 * 结构化校验 contributes（对齐 plugin.schema.json 的 contributes 子树，含
 * additionalProperties:false 与逐字段 pattern/长度/enum 约束）。非法贡献在发现期
 * 拒绝，而不是拖到 registerCommand/UI 接线阶段才失败。
 */
/**
 * 结构化校验 `settings`（契约 §4.8，对齐 plugin.schema.json 的 settings 子树）：
 * 键 = 配置键（[A-Za-z][A-Za-z0-9_]*），值 = { type, default, title?, min?, max? }。
 * 非法声明在发现期拒绝，而不是拖到 context.config 读取阶段才失败。
 */
function parseSettings(raw: unknown): PluginManifest['settings'] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plugin.json settings 必须是对象。');
  }
  const value = raw as Record<string, unknown>;
  const result: Record<string, NonNullable<PluginManifest['settings']>[string]> = {};
  const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  const TYPES = new Set(['string', 'number', 'boolean', 'string[]']);
  for (const [key, entry] of Object.entries(value)) {
    if (!KEY_RE.test(key) || key.length > 64) {
      throw new Error(`plugin.json settings 键不合法：${key}（须为 [A-Za-z][A-Za-z0-9_]*，≤64 字符）。`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`plugin.json settings.${key} 必须是对象。`);
    }
    const spec = entry as Record<string, unknown>;
    const specKeys = new Set(['type', 'default', 'title', 'min', 'max']);
    for (const k of Object.keys(spec)) {
      if (!specKeys.has(k)) throw new Error(`plugin.json settings.${key} 含未知字段：${k}。`);
    }
    const type = spec.type;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw new Error(`plugin.json settings.${key}.type 不合法：${String(type)}（须为 string/number/boolean/string[]）。`);
    }
    if (!('default' in spec)) throw new Error(`plugin.json settings.${key} 缺少 default。`);
    const def = spec.default;
    const ok = (type === 'string' && typeof def === 'string')
      || (type === 'number' && typeof def === 'number' && Number.isFinite(def))
      || (type === 'boolean' && typeof def === 'boolean')
      || (type === 'string[]' && Array.isArray(def) && def.every((v) => typeof v === 'string'));
    if (!ok) throw new Error(`plugin.json settings.${key}.default 与 type=${type} 不匹配。`);
    if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length > 64)) {
      throw new Error(`plugin.json settings.${key}.title 不合法。`);
    }
    if (spec.min !== undefined && (typeof spec.min !== 'number' || !Number.isFinite(spec.min))) {
      throw new Error(`plugin.json settings.${key}.min 不合法。`);
    }
    if (spec.max !== undefined && (typeof spec.max !== 'number' || !Number.isFinite(spec.max))) {
      throw new Error(`plugin.json settings.${key}.max 不合法。`);
    }
    result[key] = {
      type: type as 'string' | 'number' | 'boolean' | 'string[]',
      default: def as string | number | boolean | string[],
      title: typeof spec.title === 'string' ? spec.title : undefined,
      min: typeof spec.min === 'number' ? spec.min : undefined,
      max: typeof spec.max === 'number' ? spec.max : undefined,
    };
  }
  return result;
}

function parseContributions(raw: unknown): PluginManifest['contributes'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plugin.json contributes 必须是对象。');
  }
  const value = raw as Record<string, unknown>;
  const known = new Set(['parsingRoutes', 'aiProviders', 'uiCommands', 'views']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`plugin.json contributes 含未知字段：${key}。`);
  }

  const result: NonNullable<PluginManifest['contributes']> = {};

  if (value.parsingRoutes !== undefined) {
    const routes = requireCtxArray(value, 'parsingRoutes', 'contributes');
    result.parsingRoutes = routes.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`contributes.parsingRoutes[${i}] 必须是对象。`);
      const o = r as Record<string, unknown>;
      const keys = new Set(Object.keys(o));
      for (const k of keys) if (k !== 'extension' && k !== 'route') throw new Error(`contributes.parsingRoutes[${i}] 含未知字段：${k}。`);
      const extension = requireCtxString(o, 'extension', `contributes.parsingRoutes[${i}]`);
      if (!PARSING_ROUTE_EXT_RE.test(extension)) throw new Error(`contributes.parsingRoutes[${i}].extension 不合法：${extension}。`);
      const route = requireCtxString(o, 'route', `contributes.parsingRoutes[${i}]`);
      if (route.length < 1 || route.length > 64) throw new Error(`contributes.parsingRoutes[${i}].route 长度须在 1-64 之间。`);
      return { extension, route };
    });
  }

  if (value.aiProviders !== undefined) {
    const providers = requireCtxArray(value, 'aiProviders', 'contributes');
    result.aiProviders = providers.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`contributes.aiProviders[${i}] 必须是对象。`);
      const o = r as Record<string, unknown>;
      const keys = new Set(Object.keys(o));
      for (const k of keys) if (k !== 'id' && k !== 'api') throw new Error(`contributes.aiProviders[${i}] 含未知字段：${k}。`);
      const id = requireCtxString(o, 'id', `contributes.aiProviders[${i}]`);
      if (!AI_PROVIDER_ID_RE.test(id) || id.length < 1 || id.length > 64) throw new Error(`contributes.aiProviders[${i}].id 不合法：${id}。`);
      const api = requireCtxString(o, 'api', `contributes.aiProviders[${i}]`);
      if (!AI_APIS.has(api)) throw new Error(`contributes.aiProviders[${i}].api 不合法：${api}。`);
      return { id, api };
    });
  }

  if (value.uiCommands !== undefined) {
    const commands = requireCtxArray(value, 'uiCommands', 'contributes');
    result.uiCommands = commands.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`contributes.uiCommands[${i}] 必须是对象。`);
      const o = r as Record<string, unknown>;
      const keys = new Set(Object.keys(o));
      for (const k of keys) if (k !== 'id' && k !== 'title' && k !== 'panel') throw new Error(`contributes.uiCommands[${i}] 含未知字段：${k}。`);
      const id = requireCtxString(o, 'id', `contributes.uiCommands[${i}]`);
      if (!UI_COMMAND_ID_RE.test(id) || id.length < 1 || id.length > 64) throw new Error(`contributes.uiCommands[${i}].id 不合法：${id}。`);
      const title = requireCtxString(o, 'title', `contributes.uiCommands[${i}]`);
      if (title.length < 1 || title.length > 64) throw new Error(`contributes.uiCommands[${i}].title 长度须在 1-64 之间。`);
      const out: { id: string; title: string; panel?: 'sidebar' | 'command-palette' | 'toolbar' } = { id, title };
      if (o.panel !== undefined) {
        const panel = requireCtxString(o, 'panel', `contributes.uiCommands[${i}]`);
        if (!PANELS.has(panel)) throw new Error(`contributes.uiCommands[${i}].panel 不合法：${panel}。`);
        out.panel = panel as 'sidebar' | 'command-palette' | 'toolbar';
      }
      return out;
    });
  }

  if (value.views !== undefined) {
    const views = requireCtxArray(value, 'views', 'contributes');
    const seen = new Set<string>();
    result.views = views.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`contributes.views[${i}] 必须是对象。`);
      const o = r as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        if (!['id', 'title', 'location', 'entry'].includes(key)) throw new Error(`contributes.views[${i}] 含未知字段：${key}。`);
      }
      const id = requireCtxString(o, 'id', `contributes.views[${i}]`);
      if (!/^[a-z0-9-]+$/u.test(id) || id.length > 64 || seen.has(id)) throw new Error(`contributes.views[${i}].id 不合法或重复：${id}。`);
      seen.add(id);
      const title = requireCtxString(o, 'title', `contributes.views[${i}]`);
      if (title.length < 1 || title.length > 64) throw new Error(`contributes.views[${i}].title 长度须在 1-64 之间。`);
      const location = requireCtxString(o, 'location', `contributes.views[${i}]`);
      if (location !== 'settings') throw new Error(`contributes.views[${i}].location 仅支持 settings。`);
      const entry = requireCtxString(o, 'entry', `contributes.views[${i}]`);
      if (entry.length > 256 || entry.includes('\\') || entry.startsWith('/') || !entry.endsWith('.html') || entry.split('/').includes('..')) {
        throw new Error(`contributes.views[${i}].entry 必须是插件目录内的相对 HTML 路径。`);
      }
      return { id, title, location: 'settings' as const, entry };
    });
  }

  return result;
}

function requireCtxString(value: Record<string, unknown>, key: string, ctx: string): string {
  const v = value[key];
  if (typeof v !== 'string') throw new Error(`${ctx}.${key} 必须是字符串。`);
  return v;
}

function requireCtxArray(value: Record<string, unknown>, key: string, ctx: string): unknown[] {
  const v = value[key];
  if (!Array.isArray(v)) throw new Error(`${ctx}.${key} 必须是数组。`);
  return v;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const v = value[key];
  if (typeof v !== 'string') throw new Error(`plugin.json ${key} 必须是字符串。`);
  return v;
}

function optionalString(value: Record<string, unknown>, key: string, maxLen: number): string | undefined {
  const v = value[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`plugin.json ${key} 必须是字符串。`);
  if (v.length > maxLen) throw new Error(`plugin.json ${key} 长度不得超过 ${maxLen}。`);
  return v;
}

function requireArray(value: Record<string, unknown>, key: string): unknown[] {
  const v = value[key];
  if (!Array.isArray(v)) throw new Error(`plugin.json ${key} 必须是数组。`);
  return v;
}
