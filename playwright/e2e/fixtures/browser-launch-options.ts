/**
 * How the E2E fixtures launch Chromium with the wallet extension. Headed by default, as CI runs it under xvfb.
 * `E2E_HEADLESS=1` runs a local suite without opening or focusing any window: Playwright's default headless shell
 * never loads an extension, so headless uses the full Chromium build (`channel: 'chromium'`) in its new headless
 * mode, and gives it a 1600x1200 screen, since headless otherwise clamps a confirm popup to an 800x600 one.
 */
export interface BrowserLaunchOptions {
  headless: boolean;
  channel?: 'chromium';
  args: string[];
  ignoreDefaultArgs: string[];
}

export function browserLaunchOptions(
  extensionPath: string,
  env: Record<string, string | undefined> = process.env
): BrowserLaunchOptions {
  const headless = env.E2E_HEADLESS === '1';
  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    // CI hardening for the guardian recovery specs. Peak RAM on the runner is
    // high: two persistent contexts (A + B) plus the full docker stack
    // (node/sequencer/prover/2 guardians/2 postgres). `--disable-dev-shm-usage`
    // moves Chromium's shared memory off the small /dev/shm tmpfs onto disk (the
    // standard CI fix for `Target.createTarget: Failed to open a new tab`);
    // `--disable-gpu` drops the unused GPU process under xvfb. Both are inert to
    // extension/SW behaviour. (They alone did NOT stop the intermittent browser
    // crash the recovery specs hit -- that is now recovered from in reopen() by
    // relaunching the context; see relaunchContext.)
    '--disable-dev-shm-usage',
    '--disable-gpu',
    ...(headless ? ['--screen-info={1600x1200}'] : [])
  ];
  return {
    headless,
    ...(headless ? { channel: 'chromium' as const } : {}),
    args,
    ignoreDefaultArgs: ['--disable-extensions']
  };
}
