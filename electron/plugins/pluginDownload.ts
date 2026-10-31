/**
 * Plugin package downloader (binary-safe) backed by the Electron net module.
 * 插件包下载器（二进制安全），基于 Electron net 模块。
 *
 * Why not Node.js fetch: `fetch` runs on Node's own network stack, which does
 * not honor the system proxy (macOS 系统代理 / Windows IE 代理). GitHub Release
 * downloads on proxied networks then die with a bare `TypeError: fetch failed`.
 * Electron `net` runs on the Chromium network stack and automatically honors
 * system proxy and certificate settings — the same reason `webFetchClient`
 * already uses it for page fetches.
 *
 * 为何不用 Node fetch：fetch 走 Node 自带网络栈，不读系统代理（macOS 系统代理 /
 * Windows IE 代理）。走代理的网络下载 GitHub Release 时只会得到
 * `TypeError: fetch failed`。Electron net 走 Chromium 网络栈，自动遵循系统代理与
 * 证书配置 —— 与 webFetchClient 抓网页时的取舍一致。
 */
import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Overall download budget in milliseconds / 整体下载超时（毫秒）. */
export const PLUGIN_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Max redirect hops to follow / 最大重定向次数. */
const MAX_REDIRECTS = 5;

/**
 * Download a URL to a file (https only; SSRF guard applied). The destination is
 * written to `<destination>.part` first and renamed on success, so a cancelled
 * or failed download never leaves a half-written package that could be
 * mistaken for a complete one.
 * 下载 URL 到文件（仅 https；已做 SSRF 防护）。先写入 `<目标>.part`，成功后改名，
 * 中断或失败不会留下可被误认为完整的半截包。
 *
 * @param url - Target https URL / 目标 https URL
 * @param destination - Final file path / 最终文件路径
 * @param options - Optional abort signal and timeout override / 可选取消信号与超时覆盖
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('插件下载仅支持 https。');
  if (parsed.username || parsed.password) throw new Error('下载 URL 不能包含账号信息。');
  await downloadViaNet(parsed.href, destination, options);
}

interface NetDownloadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function downloadViaNet(url: string, destination: string, options: NetDownloadOptions = {}): Promise<void> {
  const partial = `${destination}.part`;
  const timeoutMs = options.timeoutMs ?? PLUGIN_DOWNLOAD_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let stream: fs.WriteStream | undefined;
    let delivered = false;

    const fail = (error: Error): void => {
      if (delivered) return;
      delivered = true;
      cleanup();
      // Remove the partial file so retries start clean / 删除半截文件，重试从干净状态开始
      try { fs.rmSync(partial, { force: true }); } catch { /* best effort */ }
      reject(error);
    };

    const succeed = (): void => {
      if (delivered) return;
      delivered = true;
      cleanup();
      try {
        fs.renameSync(partial, destination);
        resolve();
      } catch (error) {
        try { fs.rmSync(partial, { force: true }); } catch { /* best effort */ }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const cleanup = (): void => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      options.signal?.removeEventListener('abort', onAbort);
      if (stream && !stream.destroyed) stream.destroy();
    };

    const onAbort = (): void => fail(new Error('插件下载已取消。'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }

    const doRequest = (requestUrl: string): void => {
      const request = net.request({ url: requestUrl, method: 'GET', redirect: 'manual' });

      timeoutId = setTimeout(() => {
        request.abort();
        fail(new Error(`插件下载超时（已等待 ${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试。`));
      }, timeoutMs);

      request.on('redirect', (status, _method, redirectUrl) => {
        request.abort();
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
        if (redirectCount >= MAX_REDIRECTS) {
          fail(new Error('插件下载重定向次数过多。'));
          return;
        }
        redirectCount += 1;
        doRequest(redirectUrl);
      });

      request.on('response', (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 400) {
          request.abort();
          fail(new Error(describeHttpStatus(status)));
          return;
        }
        if (status >= 300) {
          // Unhandled 3xx without a Location header / 无 Location 的 3xx 响应
          request.abort();
          fail(new Error(`插件下载失败（HTTP ${status}，缺少跳转地址）。`));
          return;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        stream = fs.createWriteStream(partial, { flags: 'w' });
        stream.on('error', fail);
        response.on('data', (chunk: Buffer) => {
          if (delivered) return;
          if (stream && !stream.write(chunk)) {
            request.abort();
            fail(new Error('插件下载写盘失败。'));
          }
        });
        response.on('end', () => {
          if (delivered) return;
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
          if (!stream) { fail(new Error('插件下载未写入任何数据。')); return; }
          stream.end(() => succeed());
        });
        response.on('error', (error: Error) => fail(error));
      });

      request.on('error', (error: Error) => {
        // Surface the transport cause (DNS/TLS/proxy/socket) instead of a bare
        // "fetch failed" / 展示传输层原因（DNS/TLS/代理/套接字），而不是裸的 "fetch failed"
        fail(new Error(describeTransportError(error)));
      });

      request.end();
    };

    doRequest(url);
  });
}

/** HTTP status → actionable Chinese message / HTTP 状态码 → 可操作中文提示. */
function describeHttpStatus(status: number): string {
  if (status === 404) return '插件下载失败（HTTP 404）：地址不存在，请确认插件包链接是否正确（应为 GitHub Release 的 ZIP 直链）。';
  if (status === 401 || status === 403) return `插件下载失败（HTTP ${status}）：无权访问该地址，请检查链接是否需要登录或已失效。`;
  if (status === 429) return '插件下载失败（HTTP 429）：请求过于频繁，请稍后重试。';
  if (status >= 500) return `插件下载失败（HTTP ${status}）：服务器暂时不可用，请稍后重试。`;
  return `插件下载失败（HTTP ${status}）。`;
}

/**
 * Translate a transport-layer failure into a hint the user can act on (proxy /
 * DNS / TLS), keeping the raw cause for diagnostics.
 * 把传输层失败翻译成用户可操作的提示（代理 / DNS / TLS），并保留原始原因供诊断。
 */
function describeTransportError(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? `${cause.message}${cause.cause instanceof Error ? `（${cause.cause.message}）` : ''}` : String(cause ?? '');
  const detail = causeText ? `原因：${causeText}。` : '';
  const hint = /ENOTFOUND|EAI_AGAIN/iu.test(causeText)
    ? '请检查网络连接或 DNS 设置。'
    : /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket/iu.test(causeText)
      ? '请检查网络连接；如使用代理，请确认代理已开启且端口正确。'
      : /certificate|TLS|SSL|DEPTH_ZERO/iu.test(causeText)
        ? '请检查系统时间与证书设置；如使用代理，请确认代理未拦截 HTTPS 证书。'
        : '请检查网络连接；如使用代理，请在系统设置中开启代理后重试。';
  return `插件下载失败：${detail}${hint}`;
}
