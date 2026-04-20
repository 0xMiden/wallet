import '../../../test/jest-mocks';

import browser from 'webextension-polyfill';

import { start } from 'lib/miden/back/main';
import { request } from 'lib/miden/front/client';
import { MidenMessageType, MidenSharedStorageKey } from 'lib/miden/types';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';

import { ensureWalletReady, getState, waitForStateUpdate, PASSWORD } from '../../../test/state-helpers';

jest.mock('webextension-polyfill');
jest.mock('@demox-labs/miden-wallet-adapter-base');
jest.mock('nanoid');
jest.mock('app/hooks/useGasToken');
jest.mock('app/hooks/useMidenFaucetId');
jest.mock('lib/miden/sdk/miden-client-interface', () =>
  jest.requireActual('../../../__mocks__/lib/miden/sdk/miden-client-interface')
);
jest.mock('lib/miden/sdk/miden-client', () => jest.requireActual('../../../__mocks__/lib/miden/sdk/miden-client'));
jest.mock('lib/amp/amp-interface', () => jest.requireActual('../../../__mocks__/lib/amp/amp-interface'));
jest.mock('lib/i18n/numbers');
jest.mock('utils/string');
jest.mock('lib/miden/back/vault', () => jest.requireActual('../../../__mocks__/lib/miden/back/vault'));

describe('miden wallet smoke harness', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeAll(async () => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await start();
  });

  afterAll(() => {
    consoleLogSpy.mockRestore();
  });

  it('creates a wallet and exposes ready state over intercom', async () => {
    const readyState = await ensureWalletReady();

    expect(readyState.status).toBe(WalletStatus.Ready);
    expect(readyState.accounts).toHaveLength(1);
    expect(readyState.currentAccount?.publicKey).toBe('miden-account-1');
    expect(readyState.ownMnemonic).toBe(true);
  });

  it('locks and unlocks via background requests', async () => {
    await ensureWalletReady();

    await request({ type: WalletMessageType.LockRequest });
    const lockedState = await getState();
    expect(lockedState.status).toBe(WalletStatus.Locked);
    expect(lockedState.accounts).toHaveLength(0);

    await waitForStateUpdate(() =>
      request({
        type: WalletMessageType.UnlockRequest,
        password: PASSWORD
      })
    );

    const readyState = await getState();
    expect(readyState.status).toBe(WalletStatus.Ready);
    expect(readyState.accounts).toHaveLength(1);
  });

  it('responds to dApp page ping', async () => {
    await ensureWalletReady();
    await browser.storage.local.set({ [MidenSharedStorageKey.DAppEnabled]: true });

    const pingRes = await request({
      type: MidenMessageType.PageRequest,
      origin: 'https://example.com',
      payload: 'PING'
    });

    expect(pingRes.type).toBe(MidenMessageType.PageResponse);
    expect((pingRes as any).payload).toBe('PONG');
  });

  it('handles dApp permission and records a session', async () => {
    await ensureWalletReady();
    await browser.storage.local.set({ [MidenSharedStorageKey.DAppEnabled]: true });

    const permRes = (await request({
      type: MidenMessageType.PageRequest,
      origin: 'https://dapp.test',
      payload: {
        type: 'PERMISSION_REQUEST',
        appMeta: { name: 'Test DApp' },
        network: 'devnet'
      }
    })) as any;

    expect(permRes.type).toBe(MidenMessageType.PageResponse);
    expect(permRes.payload?.type).toBe('PERMISSION_RESPONSE');
    expect(permRes.payload?.accountId).toBe('miden-account-1');

    const sessionsRes = (await request({
      type: MidenMessageType.DAppGetAllSessionsRequest
    })) as any;

    expect(sessionsRes.sessions['https://dapp.test']?.length).toBe(1);
  });

  it('signs transactions through background', async () => {
    await ensureWalletReady();

    const res = await request({
      type: WalletMessageType.SignTransactionRequest,
      publicKey: 'miden-account-1',
      signingInputs: 'payload'
    });

    expect(res.type).toBe(WalletMessageType.SignTransactionResponse);
    expect((res as any).signature).toBe('abcd');
  });

  it('updates settings and broadcasts state', async () => {
    await ensureWalletReady();

    await waitForStateUpdate(() =>
      request({
        type: WalletMessageType.UpdateSettingsRequest,
        settings: { contacts: [{ address: 'addr1', name: 'Alice' }] }
      })
    );

    const state = await getState();
    expect(state.settings?.contacts?.[0]?.name).toBe('Alice');
  });
});
