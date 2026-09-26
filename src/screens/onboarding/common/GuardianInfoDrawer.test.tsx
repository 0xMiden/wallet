import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import GuardianInfoDrawer, {
  GuardianInfoDrawer as NamedGuardianInfoDrawer,
  GuardianInfoDrawerProps
} from './GuardianInfoDrawer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` — identity translator (labels echo the raw key) plus a
// `Trans` stub that surfaces its `i18nKey` so the description branch renders
// something assertable without dragging in the i18n runtime.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span data-testid="trans">{i18nKey}</span>
}));

// Icon barrel — a trivial stub keeps the whole `app/icons/v2` tree (and its
// chain-constants import) out of the module graph. Echo the icon `name` so the
// two `Icon`-based badges can be told apart.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="icon" data-name={name} className={className} />
  ),
  IconName: { Checkmark: 'checkmark', Close: 'close' }
}));

// `Button` — render the title and forward the click so the "gotIt" wiring can
// be verified.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button data-testid={`btn-${title}`} onClick={onClick}>
      {title}
    </button>
  )
}));

// Drawer — the real component renders through `vaul` portals; a passthrough
// stub keeps the children directly in the DOM, exposes the `open` prop, and
// gives a handle to fire `onOpenChange`.
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
  DrawerContent: ({
    children,
    className,
    overlayClassName
  }: {
    children: React.ReactNode;
    className?: string;
    overlayClassName?: string;
  }) => (
    <div data-testid="drawer-content" data-class={className} data-overlay-class={overlayClassName}>
      {children}
    </div>
  ),
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Capture the back handler the sheet registers (the hook's real body needs a mobile shell).
const mockBack: { handler: (() => boolean | void) | null; options: unknown } = { handler: null, options: undefined };
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void, _deps: unknown, options: unknown) => {
    mockBack.handler = handler;
    mockBack.options = options;
  }
}));

const makeProps = (overrides: Partial<GuardianInfoDrawerProps> = {}): GuardianInfoDrawerProps => ({
  open: true,
  onOpenChange: jest.fn(),
  ...overrides
});

const renderDrawer = (props: GuardianInfoDrawerProps = makeProps()) => render(<GuardianInfoDrawer {...props} />);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardianInfoDrawer', () => {
  it('closes on the mobile back press while open, ahead of the page under it', () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ open: true, onOpenChange }));

    expect(mockBack.options).toEqual({ overlay: true });
    expect(mockBack.handler!()).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the back press alone while closed', () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ open: false, onOpenChange }));

    expect(mockBack.handler!()).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('forwards the open prop to the drawer scaffold when open', () => {
    renderDrawer(makeProps({ open: true }));
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-content')).toBeInTheDocument();
  });

  it('forwards the open prop to the drawer scaffold when closed', () => {
    renderDrawer(makeProps({ open: false }));
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('renders the translated title in the drawer title slot', () => {
    renderDrawer();
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('whatIsAGuardian');
  });

  it('renders the hero illustration svg', () => {
    const { container } = renderDrawer();
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders the intro description via the Trans component with its i18n key', () => {
    renderDrawer();
    expect(screen.getByTestId('trans')).toHaveTextContent('guardianInfoDescription');
  });

  it('renders all three info rows with their translated titles and descriptions', () => {
    renderDrawer();
    [
      'guardianInfoWhatItDoesTitle',
      'guardianInfoWhatItDoesDescription',
      'guardianInfoSwitchingIsEasyTitle',
      'guardianInfoSwitchingIsEasyDescription',
      'guardianInfoWhatItCannotDoTitle',
      'guardianInfoWhatItCannotDoDescription'
    ].forEach(key => {
      expect(screen.getByText(key)).toBeInTheDocument();
    });
  });

  it('renders the checkmark and close icon badges plus the exclamation badge', () => {
    renderDrawer();
    const icons = screen.getAllByTestId('icon');
    const names = icons.map(icon => icon.getAttribute('data-name'));
    expect(names).toEqual(expect.arrayContaining(['checkmark', 'close']));
    // The "switching is easy" badge is a plain "!" glyph, not an Icon.
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('states the facts in the shared sheet header as plain rows, hairlines starting after the badge', () => {
    const { container } = renderDrawer();

    // The title now sits in the app's one sheet header, not in a centred hero line of its own.
    expect(screen.getByTestId('drawer-header')).toContainElement(screen.getByTestId('drawer-title'));
    // No rules across the sheet and no group fill: the rows sit on the sheet, as the testnet notice's do.
    expect(container.querySelectorAll('.border-b')).toHaveLength(0);
    expect(screen.getByText('guardianInfoWhatItDoesTitle').closest('[class*="bg-fill"]')).toBeNull();
    // The shared FactRow, whose own test pins the hairline after the badge, in an inset plain ListGroup.
    const rows = container.querySelectorAll('[data-slot="fact-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.parentElement).toHaveClass('shrink-0', '[&>*]:before:left-[var(--row-flush-inset,0px)]');
    expect(screen.getByText('guardianInfoWhatItDoesDescription')).toHaveClass('text-caption-heading', 'text-muted');
  });

  it('carries no literal colours: every badge is on a token tint', () => {
    const { container } = renderDrawer();

    const badgeOf = (glyph: HTMLElement) => glyph.closest('[aria-hidden="true"]');
    const [checkmark, close] = ['checkmark', 'close'].map(
      name => screen.getAllByTestId('icon').find(icon => icon.getAttribute('data-name') === name)!
    );
    expect(badgeOf(checkmark!)).toHaveClass('bg-positive-tint', 'text-positive-tint-ink');
    expect(badgeOf(screen.getByText('!'))).toHaveClass('bg-accent-tint', 'text-accent-tint-ink');
    expect(badgeOf(close!)).toHaveClass('bg-negative-tint', 'text-negative-tint-ink');
    // The tint replaces the shared circle's default fill rather than sitting beside it.
    for (const glyph of [checkmark!, screen.getByText('!'), close!]) expect(badgeOf(glyph)).not.toHaveClass('bg-fill');
    expect(container.innerHTML).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('never clips the sheet, so the skirt under an overshoot shows; its body shrinks to scroll instead', () => {
    renderDrawer();

    expect(screen.getByTestId('drawer-content').getAttribute('data-class') ?? '').not.toMatch(/overflow-hidden/);
    expect(screen.getByText('guardianInfoWhatItDoesTitle').closest('.overflow-y-auto')).toHaveClass('min-h-0');
  });

  it('dims the page behind with the shared sheet scrim, like every other sheet', () => {
    renderDrawer();

    // No overlay override: DrawerContent's own bg-scrim applies.
    expect(screen.getByTestId('drawer-content')).not.toHaveAttribute('data-overlay-class');
  });

  it('closes the drawer when the "gotIt" button is clicked', () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ onOpenChange }));

    fireEvent.click(screen.getByTestId('btn-gotIt'));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("propagates the drawer's own onOpenChange requests", () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ onOpenChange }));

    fireEvent.click(screen.getByTestId('drawer-onOpenChange-false'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not fire onOpenChange before any interaction', () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ onOpenChange }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedGuardianInfoDrawer).toBe(GuardianInfoDrawer);
  });
});
