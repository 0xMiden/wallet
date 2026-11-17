import React from 'react';

import { act, renderHook } from '@testing-library/react';

import { CommandDraftProvider, useCommandDrafts } from '../command-drafts';
import { useCommandBridge } from './useCommandBridge';

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.example' };
const wrapper = ({ children }: { children: React.ReactNode }) => <CommandDraftProvider scope={scope}>{children}</CommandDraftProvider>;

it('the real Bridge consumer stores exact unsigned direction, amount and external account in the shared Command draft', () => {
  const { result } = renderHook(() => ({ bridge: useCommandBridge(), drafts: useCommandDrafts() }), { wrapper });
  act(() => {
    result.current.bridge.setDirection('out');
    result.current.bridge.setAmount('1.000001');
    result.current.bridge.setExternalAccountId('0x2222222222222222222222222222222222222222');
  });
  expect(result.current.drafts.readDraft('bridge')).toEqual(expect.objectContaining({
    direction: 'out', amount: '1.000001', externalAccountId: '0x2222222222222222222222222222222222222222'
  }));
  expect(result.current.bridge.amount).toBe('1.000001');
});
