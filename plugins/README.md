# Trellora 插件开发指南

> 状态：`@experimental` —— 插件 API 在 1.4.0 冻结前可能变更。

## 1. 概述

Trellora 插件系统允许第三方扩展以下领域：

| 领域 | 扩展点 | 权限 | 说明 |
|---|---|---|---|
| 文档导入/解析 | `pipeline.registerParsingRoute` | `pipeline:parse` | 注册自定义文件扩展名的解析路由 |
| AI/LLM | `ai.registerProvider` | `ai:provider` | 注册自定义 AI 推理后端 |
| UI 命令/侧边栏按钮 | `ui.registerCommand` | `ui:command` | 注册命令面板、侧边栏或工具栏入口 |
| 设置面板页面 | `ui.registerViewHandler` | `ui:view` | 在设置中嵌入插件提供的 HTML 页面 |
| 数据源/检索 | `data.registerDataSource` | `data:source` | 提供搜索、Embedding 或向量存储源 |
| 日程同步 | `schedule.upsertItems` 等 | `schedule:write` | 按外部 ID 幂等写入日程条目 |

## 2. 目录结构

```
my-plugin/
├── plugin.json       # 插件清单（必须）
├── main.js           # 入口模块（plugin.json 的 main 字段指向）
├── settings.html     # 可选：设置面板页面（需在 contributes.views 声明）
└── assets/           # 可选资源
```

## 3. plugin.json 清单

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "Your Name",
  "license": "MIT",
  "main": "main.js",
  "engine": { "trellora": ">=1.3.0" },
  "permissions": ["ui:command", "ui:view", "data:source"],
  "activation": ["onStartup"],
  "settings": {
    "apiEndpoint": {
      "type": "string",
      "default": "https://api.example.com",
      "title": "API 端点"
    },
    "autoSync": {
      "type": "boolean",
      "default": true,
      "title": "自动同步"
    }
  },
  "contributes": {
    "uiCommands": [
      { "id": "my-plugin:hello", "title": "Hello", "panel": "sidebar" }
    ],
    "views": [
      { "id": "settings", "title": "My Plugin 设置", "location": "settings", "entry": "settings.html" }
    ]
  }
}
```

**字段说明**：
- `id`：反向 DNS 唯一标识（如 `com.example.markdown-extra`），匹配 `^[a-z0-9]+(\.[a-z0-9-]+)*$`。
- `name` / `version` / `description` / `author` / `license`：展示与元信息。
- `engine.trellora`：兼容的 Trellora 版本范围（semver range）。
- `permissions`：所需权限；L2 权限（`system:*`）需要用户显式授权。
- `activation`：激活时机（`onStartup` / `onParseRequest` / `onAiRequest` / `onUiCommand` / `*`）。
- `settings`：用户可配置项的 schema，键通过 `context.config.get(key)` 读取。
- `contributes`：静态贡献声明，与运行时注册互相印证。

完整 JSON Schema 见 [`sdk/plugin.schema.json`](sdk/plugin.schema.json)；TypeScript 类型见 [`sdk/trellora-plugin-sdk.d.ts`](sdk/trellora-plugin-sdk.d.ts)。

## 4. 入口模块

```javascript
// main.js
module.exports = {
  activate(context) {
    const { manifest, log, config, events, ui, pipeline, ai, data, schedule, secrets, files, network } = context;

    log.info(`activating ${manifest.id}`);

    // 读取 settings 默认值或用户覆盖值
    const apiEndpoint = config.get('apiEndpoint', 'https://api.example.com');
    const autoSync = config.get('autoSync', true);

    // L1: 注册 UI 命令（需要 ui:command 权限）
    ui.registerCommand({
      id: 'my-plugin:hello',
      title: 'Hello',
      panel: 'sidebar',
      execute: (args) => {
        log.info(`Hello invoked via ${args.trigger}`);
      },
    });

    // L1: 注册设置面板页面（需要 ui:view 权限，并先在 manifest contributes.views 声明）
    ui.registerViewHandler({
      viewId: 'settings',
      invoke: async ({ method, params }) => {
        if (method === 'getConfig') return { apiEndpoint, autoSync };
        if (method === 'saveConfig') {
          // 通过 events 或宿主持久化通道保存；secrets 用于敏感字段
          return { ok: true };
        }
        throw new Error(`Unknown method: ${method}`);
      },
    });

    // L1: 注册数据源（需要 data:source 权限）
    data.registerDataSource({
      id: 'my-plugin:search',
      kind: 'search',
      search: async (query, options) => {
        return [{ id: '1', title: 'Example', content: query, score: 1.0 }];
      },
    });

    // L0: 事件总线
    events.on('host:parse-request', (payload) => {
      log.info('parse requested', payload);
    });
  },

  deactivate() {
    // 可选：清理资源（宿主会自动注销已注册的贡献点）
  },
};
```

TypeScript 用户可引入 SDK 类型：

```typescript
import type { TrelloraPlugin, PluginContext } from '../../plugins/sdk/trellora-plugin-sdk';

const plugin: TrelloraPlugin = {
  activate(context: PluginContext) {
    // ...
  },
};
export default plugin;
```

## 5. 权限模型

| 层级 | 权限 | 授权方式 |
|---|---|---|
| L0 核心 | — | 无需授权（`log` / `config` / `events` / `storageDir`） |
| L1 能力 | `pipeline:parse` / `ai:provider` / `ui:command` / `ui:view` / `data:source` / `schedule:write` | Manifest 声明，安装时可见 |
| L2 系统 | `system:file` / `system:network` / `system:subprocess` | 显式授权对话框 + 运行时拦截 |

**未授权调用会抛 `PluginPermissionDeniedError`。**

### 5.1 L2 权限说明

- `system:file`：访问插件专属存储目录（`context.storageDir`）和密钥存储（`context.secrets`）。**不能**直接访问用户工作区。
- `system:network`：通过 `context.network.fetch` 发起受限 HTTP。仅允许公共 `https` 与环回 `http(s)`（`127.0.0.0/8`、`::1`、`localhost`、 `*.localhost`），拒绝内网、链路本地与带凭据 URL。
- `system:subprocess`： Reserved for future worker/spawn capabilities；当前未开放。

## 6. 配置（settings）

`plugin.json` 的 `settings` 字段声明用户可配置项：

```json
{
  "settings": {
    "maxItems": {
      "type": "number",
      "default": 100,
      "title": "最大条目数",
      "min": 1,
      "max": 1000
    },
    "tags": {
      "type": "string[]",
      "default": [],
      "title": "默认标签"
    }
  }
}
```

支持的类型：`string`、`number`、`boolean`、`string[]`。

代码中读取：

```javascript
const maxItems = context.config.get('maxItems', 100);
if (context.config.has('tags')) {
  const tags = context.config.get('tags', []);
}
```

- 未在 `settings` 中声明的键，`config.get` 永远返回 `fallback`。
- `config.keys()` 返回 manifest 中声明的所有键，供设置 UI 枚举。
- 敏感值不要放在 `settings` 中，应使用 `context.secrets`。

## 7. 密钥存储（secrets）

需要 `system:file` 权限：

```javascript
await context.secrets.set('apiKey', 'sk-...');
const apiKey = await context.secrets.get('apiKey');
await context.secrets.delete('apiKey');
```

密钥由宿主使用系统密钥链（macOS Keychain / Windows DPAPI）加密，按插件 ID 隔离。插件无法读取其他插件的密钥。

## 8. 扩展点详解

### 8.1 解析路由（`pipeline:parse`）

注册一个文件扩展名的解析器：

```javascript
context.pipeline.registerParsingRoute({
  extension: '.myext',
  route: 'my-plugin:convert',
  handler: async ({ inputPath, outputDir, signal, onProgress }) => {
    // 将 inputPath 转换为 outputDir/markdown.md
    return { markdownFile: 'markdown.md', counts: { pages: 1 } };
  },
});
```

### 8.2 AI Provider（`ai:provider`）

注册兼容 OpenAI / Ollama / Anthropic / Google 的推理后端：

```javascript
context.ai.registerProvider({
  id: 'my-ollama',
  api: 'ollama-chat',
  endpoint: 'http://localhost:11434',
  generate: async ({ prompt, system, model, signal }) => {
    // 调用自定义后端
    return { text: '...', model };
  },
  listModels: async () => ['my-model'],
});
```

### 8.3 UI 命令（`ui:command`）

```javascript
context.ui.registerCommand({
  id: 'my-plugin:hello',
  title: 'Hello',
  panel: 'sidebar', // 'sidebar' | 'command-palette' | 'toolbar'
  icon: 'sparkles', // 可选：lucide 图标名
  execute: ({ trigger, payload }) => {
    // trigger: 'command-palette' | 'sidebar' | 'toolbar'
  },
});
```

### 8.4 设置面板页面（`ui:view`）

先在 `contributes.views` 声明，再注册处理器：

```javascript
context.ui.registerViewHandler({
  viewId: 'settings',
  invoke: async ({ method, params }) => {
    if (method === 'ping') return 'pong';
    throw new Error('unknown method');
  },
});
```

页面通过 `plugin://<plugin-id>/<view-id>` 协议加载，由宿主注入与主进程通信的 bridge。

### 8.5 数据源（`data:source`）

```javascript
context.data.registerDataSource({
  id: 'my-plugin:notes',
  kind: 'search', // 'search' | 'embedding' | 'vector-store'
  search: async (query, options) => {
    return [
      { id: '1', title: 'Note A', content: '...', score: 0.95, metadata: {} },
    ];
  },
});
```

- `search` 在 `kind='search'` 时必须提供。
- `embed` 在 `kind='embedding'` 或 `'vector-store'` 时必须提供。

### 8.6 日程同步（`schedule:write`）

按 `(source, externalId)` 幂等写入或删除日程条目：

```javascript
await context.schedule.upsertItems('my-plugin:tasks', [
  {
    externalId: 'task-123',
    title: 'Review PR',
    description: '...',
    startAt: '2026-11-03T10:00:00',
    todoStatus: 'todo',
  },
]);

await context.schedule.removeItems('my-plugin:tasks', ['task-123']);
const mappings = await context.schedule.listSource('my-plugin:tasks');
```

约束：
- 单次 `upsertItems` 最多 500 条。
- 插件只能读写自己 `source` 命名空间下的条目。
- 本地完成态优先：若用户已将条目标记为完成/取消，而外部仍为未完成，则跳过状态字段更新。

## 9. 生命周期

```
安装 → 权限确认 → 注册 → 激活 → 运行 → 禁用/启用 → 升级 → 卸载
```

- **禁用/启用**：热切换，无需重启。
- **升级**：覆盖插件目录，宿主重新加载。
- **卸载**：禁用 + 删除目录 + 清除权限持久化。

## 10. 安装与分发

### 从 GitHub 安装

1. 插件作者在 GitHub 仓库发布 `plugin.zip`（含 `plugin.json` + `main.js`）
2. Trellora 设置 → 插件 → **安装**
3. 输入 GitHub release URL 或拖入 `.zip`
4. 阅读权限声明 → 确认 → 自动激活

### 本地开发

将插件目录放入 `~/.trellora/plugins/<id>/`，重启 Trellora 或在插件管理中点击刷新。

## 11. 校验清单

安装前用校验器检查 manifest：

```bash
node scripts/validate-plugin-manifest.mjs plugins/examples/hello-command
```

## 12. 错误处理

插件抛出的异常会被宿主捕获并记录到插件日志，不会崩溃主应用。常见错误：

- `PluginPermissionDeniedError`：缺少 manifest 中未声明的权限。
- `PluginTimeoutError`：单次 API 调用超出宿主执行预算。
- 自定义 `Error`：通过 `context.log.error` 记录。

## 13. 稳定性承诺

- `@experimental` API 在 1.4.0 冻结前可能变更。
- 非标记 API 遵循 semver。
- 兼容窗口：至少 2 个 minor 版本。

## 14. 校验与测试

```bash
# 校验 manifest（正反向）
pnpm run audit:plugin

# 插件系统单元校验（manifest/权限/生命周期/扩展点）
pnpm run verify:plugin-system
```

## 15. 示例

- [`examples/hello-command/`](examples/hello-command/)：最小 UI 命令插件
- [Trellora/NoticHubPlugin](https://github.com/Trellora/NoticHubPlugin)：notice-hub 群务台 · 外部数据源 → 日程同步（`schedule:write` + `system:network`；已迁出为独立插件仓库）
- [Trellora/MusicPlugin](https://github.com/Trellora/MusicPlugin)：YesPlayMusic for Trellora · 网易云音乐伴侣（榜单摘要 → 日程；已迁出为独立插件仓库）
