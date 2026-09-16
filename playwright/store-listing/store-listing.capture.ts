export type StorePlatform = 'appStore' | 'playStore' | 'chromeWebStore';
export type PlatformFlag = 'ios' | 'android' | 'chrome';

export type CapturePlanEntry = {
  id: string;
  platform: StorePlatform;
  sceneId: string;
  fixtureState: string;
  fixtureLabel: 'testnet deterministic-fixture';
  entrypoint: 'mobile.html' | 'fullpage.html' | 'sidepanel.html' | 'confirm.html';
  platformFlag: PlatformFlag;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  outputPath: string;
  ready: {
    testId: string;
    text?: string;
    hiddenTestIds: string[];
  };
};

type PointerPage = {
  mouse: { move(x: number, y: number): Promise<void> };
};

type MotionPage = {
  waitForTimeout(milliseconds: number): Promise<void>;
};

// Playwright keeps the pointer at the last clicked coordinates across route
// changes. Parking it on inert page chrome prevents native title tooltips from
// becoming part of a later product capture.
export async function parkCapturePointer(page: PointerPage): Promise<void> {
  await page.mouse.move(0, 0);
}

// Framer Motion uses requestAnimationFrame, which Playwright's disabled CSS
// animations do not fast-forward. This exceeds the app's longest 300 ms
// transition so capture never samples a moving pill or progress bar.
export async function settleCaptureMotion(page: MotionPage): Promise<void> {
  await page.waitForTimeout(500);
}

// GuardianClient appends `?scheme=ecdsa`; missing that query leaks a live
// liveness verdict into otherwise deterministic operator captures.
export const guardianPubkeyRoute = /\/pubkey(?:\?.*)?$/;

const runtimes = {
  appStore: {
    platformFlag: 'ios',
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    entrypoint: 'mobile.html'
  },
  playStore: {
    platformFlag: 'android',
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    entrypoint: 'mobile.html'
  },
  chromeWebStore: {
    platformFlag: 'chrome',
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: 1,
    entrypoint: 'sidepanel.html'
  }
} as const;

const hiddenTestIds = ['alert', 'onboarding-recovery-error', 'connectivity-banner'];

type EntryInput = Pick<CapturePlanEntry, 'sceneId' | 'fixtureState' | 'outputPath' | 'ready'> &
  Partial<Pick<CapturePlanEntry, 'entrypoint'>>;

function entry(platform: StorePlatform, input: EntryInput): CapturePlanEntry {
  const runtime = runtimes[platform];
  return {
    id: `${platform}-${input.sceneId}`,
    platform,
    sceneId: input.sceneId,
    fixtureState: input.fixtureState,
    fixtureLabel: 'testnet deterministic-fixture',
    entrypoint: input.entrypoint ?? runtime.entrypoint,
    platformFlag: runtime.platformFlag,
    viewport: runtime.viewport,
    deviceScaleFactor: runtime.deviceScaleFactor,
    outputPath: input.outputPath,
    ready: {
      testId: input.ready.testId,
      text: input.ready.text,
      hiddenTestIds: [...hiddenTestIds, ...input.ready.hiddenTestIds]
    }
  };
}

function mobileEntries(platform: 'appStore' | 'playStore', slug: 'app-store' | 'play-store') {
  const shared = [
    ['wallet-keys', 'deterministic-fixture-home', 'explore-page'],
    ['send-privacy', 'deterministic-fixture-send-private', 'dapp-confirmation-title'],
    ['receive', 'deterministic-fixture-receive', 'receive-page'],
    ['guardian', 'deterministic-fixture-guardian-picker', 'onboarding-choose-guardian']
  ] as const;

  return shared.map(([sceneId, fixtureState, testId]) =>
    entry(platform, {
      sceneId,
      fixtureState,
      outputPath: `store-listing/raw/${slug}/${sceneId}.png`,
      ready: {
        testId,
        text: sceneId === 'wallet-keys' ? '+0.00 (0.00%)' : undefined,
        hiddenTestIds: []
      }
    })
  );
}

export const capturePlan: CapturePlanEntry[] = [
  ...mobileEntries('appStore', 'app-store'),
  entry('appStore', {
    sceneId: 'ios-dapp-browser',
    fixtureState: 'deterministic-fixture-dapp-browser',
    outputPath: 'store-listing/raw/app-store/ios-dapp-browser.png',
    ready: { testId: 'dapp-hero-search', hiddenTestIds: [] }
  }),
  entry('appStore', {
    sceneId: 'ios-protection',
    fixtureState: 'deterministic-fixture-protection-picker',
    outputPath: 'store-listing/raw/app-store/ios-protection.png',
    ready: { testId: 'onboarding-choose-protection', hiddenTestIds: [] }
  }),
  ...mobileEntries('playStore', 'play-store'),
  entry('playStore', {
    sceneId: 'android-dapp-browser',
    fixtureState: 'deterministic-fixture-dapp-browser',
    outputPath: 'store-listing/raw/play-store/android-dapp-browser.png',
    ready: { testId: 'dapp-hero-search', hiddenTestIds: [] }
  }),
  entry('playStore', {
    sceneId: 'android-local-proving',
    fixtureState: 'deterministic-fixture-local-proving',
    outputPath: 'store-listing/raw/play-store/android-local-proving.png',
    ready: { testId: 'general-settings', hiddenTestIds: [] }
  }),
  entry('playStore', {
    sceneId: 'android-protection',
    fixtureState: 'deterministic-fixture-protection-picker',
    outputPath: 'store-listing/raw/play-store/android-protection.png',
    ready: { testId: 'onboarding-choose-protection', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'wallet-keys',
    fixtureState: 'deterministic-fixture-home',
    outputPath: 'store-listing/raw/chrome-web-store/wallet-keys.png',
    ready: { testId: 'explore-page', text: '+0.00 (0.00%)', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'send-privacy',
    fixtureState: 'deterministic-fixture-send-private',
    entrypoint: 'confirm.html',
    outputPath: 'store-listing/raw/chrome-web-store/send-privacy.png',
    ready: { testId: 'confirm-tx-value-note-type', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'receive',
    fixtureState: 'deterministic-fixture-receive',
    outputPath: 'store-listing/raw/chrome-web-store/receive.png',
    ready: { testId: 'receive-page', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'guardian',
    fixtureState: 'deterministic-fixture-guardian-picker',
    entrypoint: 'fullpage.html',
    outputPath: 'store-listing/raw/chrome-web-store/guardian.png',
    ready: { testId: 'onboarding-choose-guardian', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'chrome-connect',
    fixtureState: 'deterministic-fixture-connect-request',
    entrypoint: 'confirm.html',
    outputPath: 'store-listing/raw/chrome-web-store/chrome-connect.png',
    ready: { testId: 'connect-origin', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'chrome-confirm',
    fixtureState: 'deterministic-fixture-transaction-request',
    entrypoint: 'confirm.html',
    outputPath: 'store-listing/raw/chrome-web-store/chrome-confirm.png',
    ready: { testId: 'confirm-request-origin', hiddenTestIds: [] }
  }),
  entry('chromeWebStore', {
    sceneId: 'chrome-side-panel',
    fixtureState: 'deterministic-fixture-side-panel',
    outputPath: 'store-listing/raw/chrome-web-store/chrome-side-panel.png',
    ready: { testId: 'explore-page', text: '+0.00 (0.00%)', hiddenTestIds: [] }
  })
];

export function validateCapturePlan(plan: readonly CapturePlanEntry[]): void {
  const outputs = new Set<string>();
  for (const item of plan) {
    if (outputs.has(item.outputPath)) throw new Error(`Duplicate capture output: ${item.outputPath}`);
    outputs.add(item.outputPath);

    if (!item.ready.testId) throw new Error(`${item.id} must define a ready test id`);
    const expected = runtimes[item.platform];
    if (item.platformFlag !== expected.platformFlag) throw new Error(`${item.id} has an incorrect platform flag`);

    const width = item.viewport.width * item.deviceScaleFactor;
    const height = item.viewport.height * item.deviceScaleFactor;
    const expectedWidth = expected.viewport.width * expected.deviceScaleFactor;
    const expectedHeight = expected.viewport.height * expected.deviceScaleFactor;
    if (width !== expectedWidth || height !== expectedHeight) {
      throw new Error(`${item.id} has incorrect capture dimensions`);
    }
  }
}

validateCapturePlan(capturePlan);
