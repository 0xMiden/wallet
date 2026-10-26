/**
 * Desktop app entry point (Tauri)
 *
 * This is the main entry point for the desktop app built with Tauri.
 * Unlike the browser extension, the backend runs in-process (no service worker).
 * Similar to the mobile app, but with desktop-specific features like system tray.
 */

import './main.css';

import React from 'react';

import { createRoot } from 'react-dom/client';

import App from 'app/App';
import { WindowType } from 'app/env';
import { getDesktopIntercomAdapter } from 'lib/intercom/desktop-adapter';
import { initTheme } from 'lib/settings/theme';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

initTheme();

let startupErrorReported = false;

// Show error on screen for debugging
function showError(id: UserErrorId, message: string, error?: unknown) {
  if (!startupErrorReported) {
    startupErrorReported = true;
    reportUserVisibleError(id, 'startup');
  }
  console.error('Desktop app error:', message, error);
  const container = document.getElementById('root');
  if (container) {
    container.innerHTML = `
      <div style="padding: 20px; font-family: monospace; background: #fee; color: #c00;">
        <h3>Desktop App Error</h3>
        <p><strong>${message}</strong></p>
        <pre style="white-space: pre-wrap; word-break: break-word;">${error instanceof Error ? error.stack || error.message : String(error || '')}</pre>
        <hr />
        <p>Platform: Desktop (Tauri)</p>
      </div>
    `;
  }
}

// Initialize desktop backend before rendering
async function initDesktop() {
  console.log('Desktop app: Starting initialization');

  try {
    // Initialize the desktop intercom adapter (this starts the backend)
    console.log('Desktop app: Getting desktop adapter');
    const adapter = getDesktopIntercomAdapter();

    console.log('Desktop app: Initializing adapter');
    await adapter.init();

    console.log('Desktop app: Backend initialized, rendering UI');

    // Render the app
    const container = document.getElementById('root');
    if (!container) {
      showError('raw_startup_root_missing', 'Root container not found');
      return;
    }

    const root = createRoot(container);
    root.render(<App env={{ windowType: WindowType.FullPage }} />);
    console.log('Desktop app: UI rendered');
  } catch (error) {
    showError('raw_startup_init_failed', 'Failed to initialize', error);
    throw error;
  }
}

// Start the desktop app
initDesktop().catch(error => {
  showError('raw_startup_init_failed', 'Unhandled initialization error', error);
});
