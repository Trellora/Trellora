import { useEffect, useMemo, useRef, useState } from 'react';
import './PluginViewFrame.css';

interface PluginViewFrameProps {
  pluginId: string;
  viewId: string;
  entry: string;
  title: string;
}

type ViewRequest = {
  source: 'trellora-plugin-view';
  type: 'invoke';
  requestId: string;
  pluginId: string;
  viewId: string;
  method: string;
  params?: unknown;
};

export default function PluginViewFrame({ pluginId, viewId, entry, title }: PluginViewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const src = useMemo(() => {
    const resource = entry.split('/').map(encodeURIComponent).join('/');
    return `trellora-plugin://view/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}/${resource}`;
  }, [entry, pluginId, viewId]);

  useEffect(() => {
    let alive = true;
    const onMessage = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const request = event.data as Partial<ViewRequest> | null;
      if (!request || request.source !== 'trellora-plugin-view' || request.type !== 'invoke'
        || request.pluginId !== pluginId || request.viewId !== viewId
        || typeof request.requestId !== 'string' || typeof request.method !== 'string') return;
      const response = (payload: Record<string, unknown>) => {
        if (alive) frameWindow.postMessage({ source: 'trellora-plugin-host', type: 'result', requestId: request.requestId, pluginId, viewId, ...payload }, '*');
      };
      void window.electronAPI.plugin.invokeView(pluginId, viewId, request.method, request.params)
        .then((result) => response({ ok: true, result }))
        .catch((error: unknown) => response({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    };
    window.addEventListener('message', onMessage);
    return () => {
      alive = false;
      window.removeEventListener('message', onMessage);
    };
  }, [pluginId, viewId]);

  return (
    <div className="plugin-view-frame" data-plugin-id={pluginId} data-view-id={viewId}>
      {!loaded ? <div className="plugin-view-loading" role="status">正在加载插件界面…</div> : null}
      <iframe
        ref={frameRef}
        src={src}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
