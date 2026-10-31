import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';
import BrandMark from './BrandMark.tsx';
import './WindowTitleBar.css';

/** 顶部窗口栏：macOS 保留原生红绿灯，Windows / Linux 使用应用内控制按钮。 */
export default function WindowTitleBar() {
  useI18n();
  const isMac = window.electronAPI?.platform === 'darwin';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    let alive = true;
    void window.electronAPI.windowControls.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [isMac]);

  const toggleMaximized = async () => {
    const value = await window.electronAPI.windowControls.toggleMaximized();
    setMaximized(value);
  };

  return (
    <header
      className="window-titlebar"
      aria-label={t('窗口标题栏')}
      onDoubleClick={(event) => {
        if (!isMac && !(event.target as HTMLElement).closest('button')) void toggleMaximized();
      }}
    >
      <div className="window-titlebar-brand" aria-hidden="true">
        <BrandMark size={18} />
        <span>Trellora</span>
      </div>
      {!isMac ? (
        <div className="window-titlebar-controls">
          <button type="button" aria-label={t('最小化')} title={t('最小化')} onClick={() => void window.electronAPI.windowControls.minimize()}>
            <Minus size={16} strokeWidth={1.7} />
          </button>
          <button type="button" aria-label={maximized ? t('还原窗口') : t('最大化')} title={maximized ? t('还原窗口') : t('最大化')} onClick={() => void toggleMaximized()}>
            {maximized ? <Copy size={13} strokeWidth={1.7} /> : <Square size={13} strokeWidth={1.7} />}
          </button>
          <button type="button" className="window-titlebar-close" aria-label={t('关闭')} title={t('关闭')} onClick={() => void window.electronAPI.windowControls.close()}>
            <X size={16} strokeWidth={1.7} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
