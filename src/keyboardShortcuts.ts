/**
 * Centralized keyboard shortcut registry.
 * 集中式键盘快捷键注册表。
 *
 * - Single source of truth for both the live handlers and the ShortcutsModal reference.
 * - Avoids drift between the help dialog and the actual keydown listeners.
 */
import { t } from './i18n/index.ts';

export type ShortcutScope = 'global' | 'editor' | 'navigation';

export interface KeyboardShortcut {
  id: string;
  scope: ShortcutScope;
  /** Human-readable key combo shown in the shortcuts reference. */
  keys: string;
  /** Human-readable description shown in the shortcuts reference. */
  description: string;
  /** If true, the shortcut fires even when focus is inside an input/textarea. */
  allowInInput?: boolean;
  /** Returns true when this shortcut should fire for the given event. */
  match: (event: KeyboardEvent) => boolean;
}

const mod = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;

export function getKeyboardShortcuts(): KeyboardShortcut[] {
  return [
    {
      id: 'search',
      scope: 'global',
      keys: 'Cmd/Ctrl + K / P',
      description: t('打开搜索'),
      allowInInput: true,
      match: (event) => mod(event) && (event.key === 'k' || event.key === 'p'),
    },
    {
      id: 'terminal',
      scope: 'global',
      keys: 'Ctrl + `',
      description: t('打开/聚焦终端'),
      allowInInput: true,
      match: (event) => event.ctrlKey && event.key === '`',
    },
    {
      id: 'sidebar',
      scope: 'global',
      keys: 'Cmd/Ctrl + B',
      description: t('收起/展开左侧边栏'),
      match: (event) => mod(event) && !event.shiftKey && event.key === 'b',
    },
    {
      id: 'shortcuts',
      scope: 'global',
      keys: 'Cmd/Ctrl + /',
      description: t('打开快捷键速查表'),
      match: (event) => mod(event) && event.key === '/',
    },
    {
      id: 'theme',
      scope: 'global',
      keys: 'Cmd/Ctrl + Shift + L',
      description: t('切换浅色/深色外观'),
      match: (event) => mod(event) && event.shiftKey && event.key.toLowerCase() === 'l',
    },
    {
      id: 'new-note',
      scope: 'editor',
      keys: 'Cmd/Ctrl + N',
      description: t('新建笔记'),
      match: (event) => mod(event) && !event.shiftKey && event.key === 'n',
    },
    {
      id: 'save-note',
      scope: 'editor',
      keys: 'Cmd/Ctrl + S',
      description: t('保存当前笔记'),
      match: (event) => mod(event) && !event.shiftKey && event.key === 's',
    },
    {
      id: 'settings',
      scope: 'editor',
      keys: 'Cmd/Ctrl + ,',
      description: t('打开设置'),
      match: (event) => mod(event) && event.key === ',',
    },
    {
      id: 'editor-mode',
      scope: 'editor',
      keys: 'Cmd/Ctrl + Shift + E',
      description: t('切换编辑模式'),
      match: (event) => mod(event) && event.shiftKey && event.key.toLowerCase() === 'e',
    },
    {
      id: 'nav-1',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 1',
      description: t('切换到助手'),
      match: (event) => mod(event) && event.key === '1',
    },
    {
      id: 'nav-2',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 2',
      description: t('切换到笔记'),
      match: (event) => mod(event) && event.key === '2',
    },
    {
      id: 'nav-3',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 3',
      description: t('切换到文档库'),
      match: (event) => mod(event) && event.key === '3',
    },
    {
      id: 'nav-4',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 4',
      description: t('切换到 Wiki'),
      match: (event) => mod(event) && event.key === '4',
    },
    {
      id: 'nav-5',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 5',
      description: t('切换到知识图谱'),
      match: (event) => mod(event) && event.key === '5',
    },
    {
      id: 'nav-6',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 6',
      description: t('切换到日程'),
      match: (event) => mod(event) && event.key === '6',
    },
    {
      id: 'nav-7',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 7',
      description: t('切换到终端'),
      match: (event) => mod(event) && event.key === '7',
    },
    {
      id: 'nav-8',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 8',
      description: t('切换到插件库'),
      match: (event) => mod(event) && event.key === '8',
    },
    {
      id: 'nav-9',
      scope: 'navigation',
      keys: 'Cmd/Ctrl + 9',
      description: t('切换到笔记库管理'),
      match: (event) => mod(event) && event.key === '9',
    },
  ];
}

export interface ShortcutActions {
  search: () => void;
  terminal: () => void;
  sidebar: () => void;
  shortcuts: () => void;
  theme: () => void;
  'new-note': () => void;
  'save-note': () => void;
  settings: () => void;
  'editor-mode': () => void;
  'nav-1': () => void;
  'nav-2': () => void;
  'nav-3': () => void;
  'nav-4': () => void;
  'nav-5': () => void;
  'nav-6': () => void;
  'nav-7': () => void;
  'nav-8': () => void;
  'nav-9': () => void;
}

/**
 * Dispatches a keyboard event to the first matching shortcut.
 * Returns true if a shortcut was triggered.
 */
export function dispatchKeyboardShortcut(
  event: KeyboardEvent,
  actions: ShortcutActions,
  shortcuts = getKeyboardShortcuts(),
): boolean {
  const tag = (event.target as HTMLElement | null)?.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || Boolean((event.target as HTMLElement | null)?.isContentEditable);

  for (const shortcut of shortcuts) {
    if (isInput && !shortcut.allowInInput) continue;
    if (!shortcut.match(event)) continue;
    event.preventDefault();
    const action = actions[shortcut.id as keyof ShortcutActions];
    if (action) action();
    return true;
  }
  return false;
}
