import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { CommandDraftProvider, useCommandDrafts } from './command-drafts';

function DraftProbe() {
  const { readDraft, writeDraft } = useCommandDrafts();
  return (
    <>
      <button
        onClick={() =>
          writeDraft('send', {
            amount: '7.123456',
            recipientAddress: 'recipient',
            tokenId: 'token',
            privacy: 'private'
          })
        }
      >
        Save
      </button>
      <output>{readDraft('send')?.amount ?? 'empty'}</output>
    </>
  );
}

it('keeps literal decimals across route changes in one scope and discards them on account/network/RPC change or unmount', () => {
  const { rerender, unmount } = render(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'testnet', rpcUrl: 'rpc-a' }}>
      <DraftProbe />
    </CommandDraftProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('7.123456')).toBeInTheDocument();
  rerender(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'testnet', rpcUrl: 'rpc-b' }}>
      <DraftProbe />
    </CommandDraftProvider>
  );
  expect(screen.getByText('empty')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  rerender(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'devnet', rpcUrl: 'rpc-b' }}>
      <DraftProbe />
    </CommandDraftProvider>
  );
  expect(screen.getByText('empty')).toBeInTheDocument();
  unmount();
  render(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'testnet', rpcUrl: 'rpc-a' }}>
      <DraftProbe />
    </CommandDraftProvider>
  );
  expect(screen.getByText('empty')).toBeInTheDocument();
});

it('rejects a late write from a stale scope callback', () => {
  let lateWrite: (() => void) | undefined;
  function Probe() {
    const { readDraft, writeDraft } = useCommandDrafts();
    if (!lateWrite)
      lateWrite = () => writeDraft('send', { amount: '7.123456', recipientAddress: 'recipient', tokenId: 'token' });
    return <output>{readDraft('send')?.amount ?? 'empty'}</output>;
  }
  const { rerender } = render(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'n', rpcUrl: 'r' }}>
      <Probe />
    </CommandDraftProvider>
  );
  rerender(
    <CommandDraftProvider scope={{ accountId: 'b', network: 'n', rpcUrl: 'r' }}>
      <Probe />
    </CommandDraftProvider>
  );
  act(() => lateWrite?.());
  expect(screen.getByText('empty')).toBeInTheDocument();
  rerender(
    <CommandDraftProvider scope={{ accountId: 'a', network: 'n', rpcUrl: 'r' }}>
      <Probe />
    </CommandDraftProvider>
  );
  act(() => lateWrite?.());
  expect(screen.getByText('empty')).toBeInTheDocument();
});
