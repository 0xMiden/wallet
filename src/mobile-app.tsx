import './main.css';

import React from 'react';

import { Capacitor } from '@capacitor/core';
import { createRoot } from 'react-dom/client';

import App from 'app/App';
import { WindowType } from 'app/env';
import { getMobileIntercomAdapter } from 'lib/intercom/mobile-adapter';
import { initMobileBackHandler } from 'lib/mobile/back-handler';
import { initTheme } from 'lib/settings/theme';

initTheme();

// Show error on screen for debugging
function showError(message: string, error?: unknown) {
  console.error('Mobile app error:', message, error);
  const container = document.getElementById('root');
  if (container) {
    container.innerHTML = `
      <div style="padding: 20px; font-family: monospace; background: #fee; color: #c00;">
        <h3>Mobile App Error</h3>
        <p><strong>${message}</strong></p>
        <pre style="white-space: pre-wrap; word-break: break-word;">${error instanceof Error ? error.stack || error.message : String(error || '')}</pre>
        <hr />
        <p>Platform: ${Capacitor.getPlatform()}</p>
        <p>isNativePlatform: ${Capacitor.isNativePlatform()}</p>
      </div>
    `;
  }
}

// Initialize mobile backend before rendering
async function initMobile() {
  console.log('Mobile app: Starting initialization');
  console.log('Mobile app: Platform =', Capacitor.getPlatform());
  console.log('Mobile app: isNativePlatform =', Capacitor.isNativePlatform());

  try {
    // Initialize the mobile intercom adapter (this starts the backend)
    console.log('Mobile app: Getting mobile adapter');
    const adapter = getMobileIntercomAdapter();

    console.log('Mobile app: Initializing adapter');
    await adapter.init();

    console.log('Mobile app: Initializing back handler');
    await initMobileBackHandler();

    console.log('Mobile app: Backend initialized, rendering UI');

    // Render the app
    const container = document.getElementById('root');
    if (!container) {
      showError('Root container not found');
      return;
    }

    const root = createRoot(container);
    root.render(<App env={{ windowType: WindowType.FullPage }} />);
    console.log('Mobile app: UI rendered');
  } catch (error) {
    showError('Failed to initialize', error);
    throw error;
  }
}

// Start the mobile app
initMobile().catch(error => {
  showError('Unhandled initialization error', error);
});
