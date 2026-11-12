/**
 * Copies of secrets (seed phrase, private key) go through here.
 *
 * - iOS: native plugin writes a local-only item (no Universal Clipboard) that the system expires after the delay.
 * - Android: native plugin marks the clip sensitive and clears it after the delay, only if it is still ours.
 * - Extension: plain write, never cleared; a safe clear needs `clipboardRead`, a new install warning that disables
 *   the extension on update, and an unverified clear would erase whatever the user copied since.
 * - Desktop: plain write, never cleared; `readText()` raises WebKit's paste callout, so ownership cannot be checked.
 */
import { Clipboard } from '@capacitor/clipboard';
import { registerPlugin } from '@capacitor/core';

import { isMobile } from 'lib/platform';

// Twice SECRET_REVEAL_MS: pasting needs an app switch (and maybe an unlock) that re-covering a field does not.
export const SECRET_CLIPBOARD_CLEAR_MS = 60_000;

interface SecretClipboardPlugin {
  write(options: { string: string; clearAfterMs: number }): Promise<void>;
}

const SecretClipboard = registerPlugin<SecretClipboardPlugin>('SecretClipboard');

export function writeSecretToClipboard(text: string): Promise<void> {
  if (isMobile()) {
    return SecretClipboard.write({ string: text, clearAfterMs: SECRET_CLIPBOARD_CLEAR_MS });
  }
  return Clipboard.write({ string: text });
}

export function handleSecretCopyEvent(event: ClipboardEvent, text: string): void {
  event.preventDefault();
  if (!isMobile()) {
    event.clipboardData?.setData('text/plain', text);
    return;
  }
  // A WebKit write would land without the expiry, so the event data stays empty and the native write replaces it.
  if (text === '') return;
  // The error is logged without the text: a native rejection must not carry the secret into the console.
  writeSecretToClipboard(text).catch(error => {
    console.error('[clipboard] failed to copy a secret:', error);
  });
}

export function selectedFieldText(field: HTMLInputElement | HTMLTextAreaElement): string {
  return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
}
