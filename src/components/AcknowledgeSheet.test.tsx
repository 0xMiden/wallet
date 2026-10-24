import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { AcknowledgeSheet } from './AcknowledgeSheet';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

let mockDrawerScreenKey: string | undefined;

// Vaul renders through a portal jsdom cannot drive; a flat stand-in that renders children only while
// open is enough for the frame's wiring. className passes through so the scroll structure and the
// description's face are assertable.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, screenKey, children }: { open: boolean; screenKey?: string; children: React.ReactNode }) => {
    mockDrawerScreenKey = screenKey;
    return open ? <div>{children}</div> : null;
  },
  DrawerContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
  DrawerFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="drawer-footer" className={className}>
      {children}
    </div>
  )
}));

const renderSheet = (props: Partial<React.ComponentProps<typeof AcknowledgeSheet>> = {}) => {
  const onOpenChange = jest.fn();
  render(
    <AcknowledgeSheet
      open
      onOpenChange={onOpenChange}
      screenKey="ack"
      testId="ack-sheet"
      title="Sheet title"
      description="Sheet description"
      {...props}
    />
  );
  return { onOpenChange };
};

describe('AcknowledgeSheet', () => {
  beforeEach(() => {
    mockHideForegroundDapp.mockClear();
    jest.mocked(hapticLight).mockClear();
    mockDrawerScreenKey = undefined;
  });

  it('renders nothing while closed and does not hold the dApp hidden', () => {
    renderSheet({ open: false });

    expect(screen.queryByTestId('ack-sheet')).not.toBeInTheDocument();
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
  });

  it('shows the title, description and children in the scroll body, holding the dApp hidden', () => {
    renderSheet({ children: <ul data-testid="ack-rows" /> });

    expect(mockDrawerScreenKey).toBe('ack');
    expect(screen.getByRole('heading')).toHaveTextContent('Sheet title');
    const body = screen.getByTestId('ack-sheet-body');
    expect(body).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(body).toContainElement(screen.getByText('Sheet description'));
    expect(body).toContainElement(screen.getByTestId('ack-rows'));
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);
  });

  it('closes on "I understand", pinned outside the scroll body, with the Button’s own single haptic', () => {
    const { onOpenChange } = renderSheet();

    const cta = screen.getByTestId('ack-sheet-cta');
    expect(cta).toHaveTextContent('iUnderstand');
    expect(screen.getByTestId('ack-sheet-body')).not.toContainElement(cta);
    expect(cta.closest('[data-slot="drawer-footer"]')).not.toBeNull();

    fireEvent.click(cta);

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('keeps the drawer caption by default and sets a whole-message description in the heading face', () => {
    renderSheet();
    expect(screen.getByText('Sheet description')).not.toHaveClass('face-heading');

    renderSheet({ description: 'Whole message', descriptionVariant: 'message' });
    expect(screen.getByText('Whole message')).toHaveClass('face-heading', 'text-body-strong');
  });
});
