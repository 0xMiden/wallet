import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import { TransferTypeDrawer } from './TransferTypeDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

// The public explanation slides open on the `reveal` preset; the test reads the DOM, not the motion.
jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef(
        ({ initial: _i, animate: _a, exit: _e, transition: _t, ...props }: any, ref: React.Ref<HTMLDivElement>) => (
          <div ref={ref} {...props} />
        )
      )
    },
    useReducedMotion: () => false
  };
});

// Stubs the accent through to a `data-accent` attribute (the SendAmount.test.tsx pattern) so
// Done's flow colour is assertable without the real Button's cva class computation.
jest.mock('components/ui/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, variant: _variant, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));

// Drawer — the real component renders through `vaul` portals; a passthrough stub keeps the
// children (and their handlers) directly in the DOM and exposes the `open` prop.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-onOpenChange-false" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-footer">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

const renderDrawer = (value: 'private' | 'public' = 'private') => {
  const onOpenChange = jest.fn();
  const onChange = jest.fn();
  render(<TransferTypeDrawer open onOpenChange={onOpenChange} value={value} onChange={onChange} />);
  return { onOpenChange, onChange };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TransferTypeDrawer', () => {
  it('offers Private (the default) and Public as one radio group, with the current choice checked', () => {
    renderDrawer();

    expect(screen.getByTestId('drawer-title')).toHaveTextContent('transferType');
    expect(screen.getByRole('radiogroup', { name: 'transferType' })).toBeInTheDocument();
    const privateRow = screen.getByRole('radio', { name: /private/ });
    const publicRow = screen.getByRole('radio', { name: /public/ });
    expect(privateRow).toHaveAttribute('aria-checked', 'true');
    expect(publicRow).toHaveAttribute('aria-checked', 'false');
    expect(privateRow).toHaveTextContent('default');
    // One tab stop for the group, on the current choice.
    expect(privateRow).toHaveAttribute('tabindex', '0');
    expect(publicRow).toHaveAttribute('tabindex', '-1');
  });

  it('reports a tapped choice once, with the selection haptic, and ignores a tap on the current one', () => {
    const { onChange } = renderDrawer();

    fireEvent.click(screen.getByRole('radio', { name: /private/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(hapticSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: /public/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('public');
    expect(hapticSelection).toHaveBeenCalledTimes(1);
  });

  it('moves the choice with the arrow keys', () => {
    const { onChange } = renderDrawer();

    fireEvent.keyDown(screen.getByRole('radio', { name: /private/ }), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('public');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /public/ }));
  });

  it('explains what a public note reveals only while Public is the choice', () => {
    renderDrawer('private');
    expect(screen.queryByTestId('transfer-type-public-help')).not.toBeInTheDocument();
  });

  it('spells out the public consequence and the sender note under the group for Public', () => {
    renderDrawer('public');
    expect(screen.getByRole('radio', { name: /public/ })).toHaveAttribute('aria-checked', 'true');
    const help = screen.getByTestId('transfer-type-public-help');
    expect(help).toHaveTextContent('publicTransferHelp');
    expect(help).toHaveTextContent('senderAddressPublicNote');
  });

  it('closes on Done, in the send flow colour, without changing the choice', () => {
    const { onOpenChange, onChange } = renderDrawer();

    const done = screen.getByTestId('transfer-type-done');
    expect(done).toHaveTextContent('done');
    expect(done).toHaveAttribute('data-accent', 'send');
    fireEvent.click(done);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
