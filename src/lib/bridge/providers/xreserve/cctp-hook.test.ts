// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/cctp-deposit.test.ts (MIT).
import { slice } from 'viem';

import 'lib/bridge/testing/fixtures';
import { getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { encodeExecutorHookData } from 'lib/usdcx/executor';
import { midenAccountHexToXReserveRecipient } from 'lib/usdcx/recipient';

import fixture from './fixtures/cctp-hook.json';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () =>
  jest.requireActual('lib/bridge/testing/fixtures').referenceSnapshot('testnet') }));

it('retains wallet hook order while matching both exact pinned Circle frames and payload lengths', () => {
  const sender = '0x1111111111111111111111111111111111111111';
  const encoded = encodeExecutorHookData(getUsdcxExecutorSource(11155111).target,
    midenAccountHexToXReserveRecipient(fixture.recipient), sender);
  const pinned = `0x${fixture.hook.slice(2)}` satisfies `0x${string}`;
  expect(encoded.length).toBe(1410);
  expect(slice(encoded, 0, 24)).toBe('0x636374702d666f7277617264000000000000000000000000');
  expect(slice(encoded, 24, 32)).toBe('0x0000000100000000');
  expect(slice(encoded, 32 + 24, 32 + 32)).toBe('0x0000000100000280');
  expect(slice(encoded, 0, 32)).toBe(slice(pinned, 672));
  expect(slice(encoded, 32)).toBe(slice(pinned, 0, 672));
});
