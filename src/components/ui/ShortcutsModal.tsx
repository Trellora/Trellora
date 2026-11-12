/**
 * ShortcutsModal — keyboard shortcuts reference (Cmd+/ or ?).
 * 快捷键速查表 —— 全局呼出（Cmd+/ 或 ?）。
 *
 * Renders the centralized shortcut registry so the help dialog always matches
 * the actual key handlers registered in App.tsx.
 */
import React, { useMemo } from 'react';
import { Modal, Stack, Group, Text, Kbd, Divider } from '@mantine/core';
import { t, useI18n } from '../../i18n/index.ts';
import { getKeyboardShortcuts, type ShortcutScope } from '../../keyboardShortcuts.ts';

const scopeTitles: Record<ShortcutScope, string> = {
  global: t('全局'),
  editor: t('编辑器'),
  navigation: t('导航'),
};

const scopeOrder: ShortcutScope[] = ['global', 'editor', 'navigation'];

export default function ShortcutsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  useI18n();
  const groups = useMemo(() => {
    const shortcuts = getKeyboardShortcuts();
    const byScope = new Map<ShortcutScope, typeof shortcuts>();
    for (const shortcut of shortcuts) {
      const list = byScope.get(shortcut.scope) ?? [];
      list.push(shortcut);
      byScope.set(shortcut.scope, list);
    }
    return scopeOrder
      .map((scope) => ({ scope, title: scopeTitles[scope], items: byScope.get(scope) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, []);

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={t('键盘快捷键')}
      centered
      size="md"
      radius="md"
    >
      <Stack gap="lg">
        {groups.map((group) => (
          <Stack key={group.scope} gap="xs">
            <Text size="sm" fw={600}>{group.title}</Text>
            <Divider />
            {group.items.map((item) => (
              <Group key={item.id} justify="space-between" gap="md">
                <Text size="sm">{item.description}</Text>
                <Kbd>{item.keys}</Kbd>
              </Group>
            ))}
          </Stack>
        ))}
      </Stack>
    </Modal>
  );
}
