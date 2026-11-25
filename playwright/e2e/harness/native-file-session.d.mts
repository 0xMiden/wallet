import type { Page, Worker } from '@playwright/test';

export class NativeFileCaptureSession {
  static prepare(dir: string, wallet: 'A' | 'B'): Promise<NativeFileCaptureSession>;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  start(page: Page, worker: Worker, useWalletProbe?: boolean): Promise<void>;
  assertHealthy(): void;
  interrupt(): void;
  end(page: Page, worker: Worker): Promise<void>;
  finish(contextClosed: boolean): Promise<boolean>;
}
