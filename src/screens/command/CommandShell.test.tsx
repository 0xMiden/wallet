import React, { useState } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionConfig } from 'framer-motion';

import { AlertSheet } from 'components/ui/AlertSheet';
import { goBack, navigate } from 'lib/woozie';

import { useCommandDrafts } from './command-drafts';
import { CommandShell } from './CommandShell';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1, href: '/send' }),
  listen: () => () => {},
  HistoryAction: { Replace: 'REPLACE' }
}));

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.test' };

beforeEach(() => jest.clearAllMocks());

it('renders one active workbench and navigates via the five dock destinations', () => {
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <div>Real send controller</div>
    </CommandShell>
  );
  expect(screen.getAllByTestId('command-workbench')).toHaveLength(1);
  expect(screen.getByRole('main')).toContainElement(screen.getByTestId('command-workbench'));
  expect(screen.getByText('Real send controller')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(goBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'receive' }));
  expect(navigate).toHaveBeenCalledWith('/receive');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'swap' }}>
      <div>Real swap controller</div>
    </CommandShell>
  );
  expect(screen.getAllByTestId('command-shell')).toHaveLength(1);
  expect(screen.getByText('Real swap controller')).toBeInTheDocument();
  expect(screen.queryByText('Real send controller')).not.toBeInTheDocument();
});

it.each([
  ['send', '/send'],
  ['receive', '/receive'],
  ['swap', '/swap'],
  ['earn', '/earn/positions'],
  ['commandBridge', '/bridge/deposit']
])('opens %s through the real Command dock', (label, path) => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(navigate).toHaveBeenCalledWith(path);
});

it('keeps a provider consumer’s unsigned literal draft on minimize and clears it on scope change', () => {
  function Probe() {
    const { readDraft, writeDraft } = useCommandDrafts();
    return (
      <>
        <button
          onClick={() => writeDraft('send', { amount: '7.123456', recipientAddress: 'recipient', tokenId: 'token' })}
        >
          Save amount
        </button>
        <output>{readDraft('send')?.amount ?? 'empty'}</output>
      </>
    );
  }
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <Probe />
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  fireEvent.click(screen.getByRole('button', { name: 'minimize' }));
  expect(navigate).toHaveBeenCalledWith('/');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      <Probe />
    </CommandShell>
  );
  expect(screen.getByText('7.123456')).toBeInTheDocument();
  rerender(
    <CommandShell scope={{ ...scope, accountId: 'account-b' }} route={{ kind: 'dashboard' }}>
      <Probe />
    </CommandShell>
  );
  expect(screen.getByText('empty')).toBeInTheDocument();
});

it('scopes the FullPage root dimensions and restores the original inline defaults on exit', () => {
  const previousMinWidth = document.documentElement.style.minWidth;
  const previousMargin = document.body.style.marginTop;
  const previousHtmlHeight = document.documentElement.style.height;
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  document.documentElement.style.minWidth = '640px';
  document.body.style.marginTop = '24px';
  try {
    const { unmount } = render(
      <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
        {null}
      </CommandShell>
    );
    expect(document.documentElement.style.minWidth).toBe('0px');
    expect(document.body.style.marginTop).toBe('0px');
    expect(document.documentElement.style.height).toBe('100%');
    expect(root.style.height).toBe('100%');
    unmount();
    expect(document.documentElement.style.minWidth).toBe('640px');
    expect(document.body.style.marginTop).toBe('24px');
    expect(document.documentElement.style.height).toBe(previousHtmlHeight);
    expect(root.style.height).toBe('');
  } finally {
    root.remove();
    document.documentElement.style.minWidth = previousMinWidth;
    document.documentElement.style.height = previousHtmlHeight;
    document.body.style.marginTop = previousMargin;
  }
});

it('keeps the shell while replacing the operation controller for a different transaction ID', () => {
  function Operation({ id }: { id: string }) {
    const [mountedId] = useState(id);
    return <output>{mountedId}</output>;
  }
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'tx1' }}>
      <Operation id="tx1" />
    </CommandShell>
  );
  const shell = screen.getByTestId('command-shell');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'tx2' }}>
      <Operation id="tx2" />
    </CommandShell>
  );
  expect(screen.getByTestId('command-shell')).toBe(shell);
  expect(screen.getByText('tx2')).toBeInTheDocument();
  expect(screen.queryByText('tx1')).not.toBeInTheDocument();
});

it('minimizes only the active workbench when Escape has no higher dialog', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <div>Controller</div>
    </CommandShell>
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(navigate).toHaveBeenCalledWith('/');
});

it('keeps the workbench mounted when an intervening security confirmation takes Escape', () => {
  function SecurityStep() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Confirm spend</button>
        <AlertSheet
          open={open}
          title="Confirm spend"
          actionLabel="Proceed"
          onAction={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          cancelLabel="Cancel"
        >
          Review the amount
        </AlertSheet>
      </>
    );
  }
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <SecurityStep />
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm spend' }));
  expect(screen.getByRole('alertdialog', { name: 'Confirm spend' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('alertdialog', { name: 'Confirm spend', hidden: true })).toHaveAttribute(
    'data-state',
    'closed'
  );
  expect(screen.getByTestId('command-workbench')).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalledWith('/');
});

it('keeps Command controls functional with reduced motion', () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    render(
      <MotionConfig reducedMotion="always">
        <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
          <div>Dashboard slot</div>
        </CommandShell>
      </MotionConfig>
    );
    fireEvent.click(screen.getByRole('button', { name: 'commandSearch' }));
    expect(screen.getByRole('dialog', { name: 'commandSearch' })).toBeInTheDocument();
  } finally {
    warning.mockRestore();
  }
});

it('opens an accessible palette, selects with arrows and Enter, Escape closes and returns focus', async () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      <div>Dashboard slot</div>
    </CommandShell>
  );
  const trigger = screen.getByRole('button', { name: 'commandSearch' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'commandSearch' })).toBeInTheDocument();
  const input = screen.getByRole('combobox', { name: 'commandSearch' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(navigate).toHaveBeenCalledWith('/send');
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'commandSearch' })).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});
