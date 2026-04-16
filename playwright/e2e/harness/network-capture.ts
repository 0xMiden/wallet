import type { Page, Request, Response } from '@playwright/test';

import type { TimelineRecorder } from './timeline-recorder';
import type { NetworkCategory } from './types';

const ENDPOINT_PATTERNS: Record<NetworkCategory, RegExp> = {
  rpc: /rpc\.(testnet|devnet)\.miden\.io|localhost:57291/,
  transport: /transport\.miden\.io|localhost:57292/,
  prover: /tx-prover\.(testnet|devnet)\.miden\.io|localhost:50051/,
  other: /.*/, // fallback
};

function classifyUrl(url: string): NetworkCategory {
  for (const [category, pattern] of Object.entries(ENDPOINT_PATTERNS)) {
    if (category !== 'other' && pattern.test(url)) {
      return category as NetworkCategory;
    }
  }
  return 'other';
}

function isMidenRelated(url: string): boolean {
  return classifyUrl(url) !== 'other';
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + `... (truncated, ${s.length} total)` : s;
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/**
 * Attach network request/response capture to a page.
 * Only captures Miden-related requests (RPC, transport, prover).
 */
export function attachNetworkCapture(
  page: Page,
  walletLabel: 'A' | 'B',
  timeline: TimelineRecorder
): void {
  page.on('requestfinished', async (request: Request) => {
    const url = request.url();
    if (!isMidenRelated(url)) return;

    const category = classifyUrl(url);
    const response = await request.response();
    const status = response?.status() ?? 0;
    const responseBody = response ? truncate((await safeResponseText(response)) ?? '', 4096) : undefined;

    timeline.emit({
      category: 'network_request',
      severity: status >= 400 ? 'error' : 'info',
      wallet: walletLabel,
      message: `${request.method()} ${url} -> ${status}`,
      data: {
        url,
        method: request.method(),
        status,
        responseBody,
        networkCategory: category,
        timing: request.timing(),
      },
    });
  });

  page.on('requestfailed', (request: Request) => {
    const url = request.url();
    if (!isMidenRelated(url)) return;

    const category = classifyUrl(url);
    timeline.emit({
      category: 'network_request',
      severity: 'error',
      wallet: walletLabel,
      message: `FAILED ${request.method()} ${url}: ${request.failure()?.errorText}`,
      data: {
        url,
        method: request.method(),
        failureText: request.failure()?.errorText,
        networkCategory: category,
      },
    });
  });
}
