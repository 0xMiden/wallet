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

// Whatever fails in here costs the background time and never the run. Native ends a task itself on expiry, so an
// `end` that is lost is not a leak.
function beginBackgroundExecution(): () => void {
  try {
    if (!isIOS()) return noop;
    const native = getPlugin();
    // Caught now, not when the run ends: the run can outlast a rejected begin, which would go unhandled until then.
    const begun: Promise<BeginResult> = native.begin().catch(() => NOT_GRANTED);
    return () => {
      // Chained on the begin, so a key that arrives after the run finished is still ended, and only once.
      begun.then(task => (task.granted ? native.end({ key: task.key }) : undefined)).catch(noop);
    };
  } catch {
    return noop;
  }
}

/**
 * Runs `run` with iOS asked for time to finish it if the app leaves the foreground meanwhile. Off iOS it only calls
 * `run`.
 *
 * This buys limited time, and what it does for JavaScript in the web view has not been measured on a device (see
 * `BackgroundExecutionPlugin.swift`), so nothing may depend on it. `run` starts at once, without waiting on the bridge,
 * and its result or rejection comes back untouched, whatever the bridge does.
 */
export async function runWithBackgroundExecution<T>(run: () => Promise<T>): Promise<T> {
  const end = beginBackgroundExecution();
  try {
    return await run();
  } finally {
    end();
  }
}
