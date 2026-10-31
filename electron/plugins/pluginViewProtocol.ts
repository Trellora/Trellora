import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginHost } from './pluginHost.ts';

export const PLUGIN_VIEW_SCHEME = 'trellora-plugin';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const VIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Must run before app.ready; views remain sandboxed and have no Node integration. */
export function registerPluginViewScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PLUGIN_VIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  }]);
}

/** Serves only files inside an active plugin's declared view directory. */
export function registerPluginViewProtocol(getHost: () => PluginHost): void {
  protocol.handle(PLUGIN_VIEW_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'view') throw new Error('Invalid view host');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments.length < 3 || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) throw new Error('Invalid view path');
      const [pluginId, viewId, ...resourceSegments] = segments;
      const plugin = getHost().registry.get(pluginId);
      if (!plugin || plugin.state !== 'active') return new Response('Plugin is not active', { status: 403 });
      const view = plugin.manifest.contributes?.views?.find((entry) => entry.id === viewId);
      if (!view) return new Response('View not found', { status: 404 });
      const root = await fs.promises.realpath(plugin.rootDir);
      const viewRoot = await fs.promises.realpath(path.dirname(path.resolve(root, view.entry)));
      const filePath = await fs.promises.realpath(path.resolve(root, ...resourceSegments));
      if (!filePath.startsWith(viewRoot + path.sep)) throw new Error('View path escapes declared view directory');
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
      const extension = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[extension];
      if (!contentType) return new Response('Unsupported asset type', { status: 415 });
      const bytes = await fs.promises.readFile(filePath);
      const headers: Record<string, string> = { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (extension === '.html') headers['content-security-policy'] = VIEW_CSP;
      return new Response(bytes, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
