import { type PluginListenerHandle, registerPlugin } from '@capacitor/core';

import { isIOS } from 'lib/platform';

type BeginResult = { granted: true; key: string } | { granted: false };

interface BackgroundExecutionPlugin {
  begin(): Promise<BeginResult>;
  end(options: { key: string }): Promise<void>;
  addListener(eventName: 'expired', listenerFunc: () => void): Promise<PluginListenerHandle>;
}

const NOT_GRANTED: BeginResult = { granted: false };

const noop = () => {};

let plugin: BackgroundExecutionPlugin | null = null;

/** Test-only: forget the registered plugin and its listener. */
export function __resetBackgroundExecutionForTest(): void {
  plugin = null;
}

// On first use rather than on import: the transaction pipeline loads this module in realms that never get here, the
// extension's service worker among them. The listener goes first, so it is in place before any task can expire.
function getPlugin(): BackgroundExecutionPlugin {
  if (plugin === null) {
    plugin = registerPlugin<BackgroundExecutionPlugin>('BackgroundExecution');
    plugin
      .addListener('expired', () => {
        console.warn('[background-execution] iOS ended the background time of a transaction attempt');
      })
      .catch(noop);
  }
  return plugin;
}

/**
 * Asks iOS for time to finish the work now starting if the app leaves the foreground meanwhile, and returns what ends
 * that time. Off iOS it asks nothing and the returned function does nothing.
 *
 * This buys limited time, and what it does for JavaScript in the web view has not been measured on a device (see
 * `BackgroundExecutionPlugin.swift`), so nothing may depend on it. Neither call throws or waits on the bridge: whatever
 * fails in here costs the background time and never the work. Native ends a task itself on expiry, so an `end` that is
 * lost is not a leak.
 */
export function beginBackgroundExecution(): () => void {
  try {
    if (!isIOS()) return noop;
    const native = getPlugin();
    // Caught now, not when the work ends: the work can outlast a rejected begin, which would go unhandled until then.
    const begun: Promise<BeginResult> = native.begin().catch(() => NOT_GRANTED);
    return () => {
      // Chained on the begin, so a key that arrives after the work finished is still ended, and only once.
      begun.then(task => (task.granted ? native.end({ key: task.key }) : undefined)).catch(noop);
    };
  } catch {
    return noop;
  }
}
