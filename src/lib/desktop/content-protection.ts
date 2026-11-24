import { isDesktop } from 'lib/platform';

/**
 * Excludes the desktop wallet window from screen capture while `enabled`.
 * No-op outside the desktop app; a rejection from the native command propagates.
 */
export async function setWindowContentProtected(enabled: boolean): Promise<void> {
  if (!isDesktop()) {
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_content_protection', { enabled });
}
