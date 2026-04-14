import type { BrowserContext, ConsoleMessage, Page } from '@playwright/test';

import type { TimelineRecorder } from './timeline-recorder';
import type { EventSeverity } from './types';

function consoleSeverity(type: string): EventSeverity {
  switch (type) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warn';
    case 'debug':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

/**
 * Attach console and error capture to all pages in a BrowserContext.
 * Emits browser_console events to the timeline for every console message
 * and uncaught exception.
 */
export function attachConsoleCapture(
  context: BrowserContext,
  walletLabel: 'A' | 'B',
  timeline: TimelineRecorder
): void {
  const onPage = (page: Page) => {
    page.on('console', (msg: ConsoleMessage) => {
      timeline.emit({
        category: 'browser_console',
        severity: consoleSeverity(msg.type()),
        wallet: walletLabel,
        message: `[${walletLabel}] ${msg.type()}: ${msg.text()}`,
        data: {
          type: msg.type(),
          text: msg.text(),
          url: page.url(),
          location: msg.location(),
        },
      });
    });

    page.on('pageerror', (error: Error) => {
      timeline.emit({
        category: 'browser_console',
        severity: 'error',
        wallet: walletLabel,
        message: `[${walletLabel}] Uncaught exception: ${error.message}`,
        data: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          url: page.url(),
        },
      });
    });
  };

  // Capture from existing pages
  for (const page of context.pages()) {
    onPage(page);
  }

  // Capture from future pages (extension may open new tabs)
  context.on('page', onPage);
}
