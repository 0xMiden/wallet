import type { CdpSession } from './cdp-bridge';
import { IosWalletPage } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';

describe('IosWalletPage.screenshot', () => {
  it('runs the before-capture hook before it shoots', async () => {
    const order: string[] = [];
    const sim = {
      screenshot: jest.fn(async () => {
        order.push('shot');
      })
    } as unknown as SimulatorControl;
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim,
      udid: 'udid',
      bundleId: 'bundle',
      beforeCapture: async () => {
        order.push('gate');
      }
    });

    await page.screenshot({ path: 'shot.png' });

    expect(order).toEqual(['gate', 'shot']);
  });

  it('shoots without a hook', async () => {
    const screenshot = jest.fn(async () => undefined);
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim: { screenshot } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.screenshot({ path: 'shot.png' });

    expect(screenshot).toHaveBeenCalledWith('udid', 'shot.png');
  });
});

describe('IosWalletPage.prepareSendReview', () => {
  it('scopes shared amount controls to the Send flow', async () => {
    const evalJs = jest.fn(async () => true);
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });
    const pollForSelector = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateTo: jest.fn(async () => undefined),
      pollForSelector,
      pollForCondition: jest.fn(async () => undefined),
      fillInput: jest.fn(async () => undefined),
      click,
      clickWhenEnabled: jest.fn(async () => undefined)
    });

    await page.prepareSendReview({
      recipientAddress: 'mtst1recipient',
      amount: '2',
      tokenSymbol: 'TST',
      isPrivate: false
    });

    const sendFlow = '[data-testid="send-flow"]';
    expect(pollForSelector).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-token-selector"]`, 15_000);
    expect(click).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-token-selector"]`);
    expect(pollForSelector).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-amount-input"]`, 30_000);
    expect(pollForSelector).toHaveBeenCalledWith('[data-testid="send-review-submit"]', 45_000);
  });
});

// /bridge/deposit slides over the Home tabs, which stay mounted (inert) earlier in the DOM; their Swap pane reuses the
// bridge form's test ids, so an unscoped lookup clicked the hidden Swap "You Pay" selector (live run 38087775886).
describe('IosWalletPage bridge deposit helpers', () => {
  it('scopes shared amount controls to the bridge page layer', async () => {
    const page = new IosWalletPage({
      cdp: { eval: jest.fn(async () => true) } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });
    const waitFor = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    const pollForSelector = jest.fn(async () => undefined);
    const fillInput = jest.fn(async () => undefined);
    const clickWhenEnabled = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateTo: jest.fn(async () => undefined),
      waitFor,
      click,
      pollForSelector,
      fillInput,
      clickWhenEnabled
    });

    await page.openBridgeDeposit();
    await page.selectBridgeToken('CIRCLE_USDC');
    await page.enterBridgeAmount('0.01');

    const bridge = '[data-page-layer="/bridge/deposit"]';
    expect(waitFor).toHaveBeenCalledWith(`${bridge} [data-testid="send-token-selector"]`, { timeoutMs: 8_000 });
    expect(click).toHaveBeenCalledWith(`${bridge} [data-testid="send-token-selector"]`);
    // The token drawer portals to <body>, outside the layer.
    expect(click).toHaveBeenCalledWith('[data-testid="bridge-token-CIRCLE_USDC"]');
    expect(pollForSelector).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-input"]`, 15_000);
    expect(fillInput).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-input"]`, '0.01');
    expect(clickWhenEnabled).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-confirm"]`, 15_000);
    const unscoped = [...waitFor.mock.calls, ...click.mock.calls, ...pollForSelector.mock.calls]
      .map(call => String((call as unknown[])[0]))
      .filter(
        selector => /send-(token-selector|amount-input|amount-confirm)/.test(selector) && !selector.startsWith(bridge)
      );
    expect(unscoped).toEqual([]);
  });
});

describe('IosWalletPage.hexToBech32Faucet', () => {
  it('passes only the hex id to the wallet-owned network-aware hook', async () => {
    const evalJs = jest.fn(async (_script: string) => 'mlcl1tracked');
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await expect(page.hexToBech32Faucet('0xtracked')).resolves.toBe('mlcl1tracked');

    expect(evalJs).toHaveBeenCalledTimes(1);
    const script = evalJs.mock.calls[0]![0];
    expect(script).toContain('window.__TEST_HEX_TO_BECH32_FAUCET__("0xtracked")');
    expect(script).not.toMatch(/testnet|devnet/);
  });

  it('injects metadata through the same hex-only hook contract', async () => {
    const evalJs = jest.fn(async (script: string) => {
      if (script.includes('typeof window.__TEST_HEX_TO_BECH32_FAUCET__')) return true;
      return { before: [], injected: ['mlcl1tracked'], after: ['mlcl1tracked'] };
    });
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await (
      page as unknown as { injectTestMetadataForFaucets(ids: string[]): Promise<void> }
    ).injectTestMetadataForFaucets(['0xtracked']);

    const injectionScript = evalJs.mock.calls.find(([script]) => script.includes('var conv'))?.[0];
    expect(injectionScript).toContain('.map(hex => conv(hex))');
    expect(injectionScript).not.toMatch(/testnet|devnet/);
  });
});
