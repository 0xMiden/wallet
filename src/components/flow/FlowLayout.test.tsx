import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { SendStepLayout } from 'screens/send-flow/SendStepLayout';

import { FlowLayout } from './FlowLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true, isAndroid: () => false }));
jest.mock('app/icons/v2', () => ({
  IconName: { ArrowLeft: 'arrow-left', ChevronLeft: 'chevron-left', Close: 'close' },
  // Keep name and className: the glyph and its colour are what the back assertions check, and a
  // mock that drops them makes those assertions unfalsifiable.
  Icon: ({ name, className }: { name: string; className?: string }) => <svg data-name={name} className={className} />
}));

describe('FlowLayout', () => {
  it('renders the title, content, footer, and a back button that calls onBack', () => {
    const onBack = jest.fn();
    render(
      <FlowLayout title="Title" onBack={onBack} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('takes no title accessory: the header is the title alone', () => {
    render(
      // @ts-expect-error titleAccessory is not a FlowLayout prop; no page passes one.
      <FlowLayout tabRoot title="Title" titleAccessory={<span>chip</span>} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.queryByText('chip')).not.toBeInTheDocument();
  });

  it('styles back as an ink arrow on the fill circle, never the flow accent', () => {
    // Flow accents are under 3:1 on white, so the spec keeps them off text and the back button.
    // The color lives on the IconButton itself (a `filled` IconButton is always `ink`) and the
    // glyph inherits it through `fill="currentColor"` — same pattern PageHeader.test.tsx checks.
    render(
      <SendStepLayout title="Title" onBack={jest.fn()} footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    const back = screen.getByTestId('flow-back');
    // The shared pushed-page back button: an ink arrow on the 44px round fill circle.
    expect(back).toHaveClass('bg-fill', 'rounded-full', 'text-ink');
    expect(back).not.toHaveClass('text-accent-send');
    const glyph = back.querySelector('svg');
    expect(glyph).toHaveAttribute('data-name', 'arrow-left');
  });

  it("starts a tab-root step's content where a pushed step's starts: 36px above a 36px title", () => {
    // A pushed step's content starts under the 60px PageHeader row, its 4px rule and the 8px under it: 72px.
    render(
      <FlowLayout title="Send" tabRoot footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );
    const body = screen.getByRole('heading', { level: 1 }).closest('header')!.parentElement!;
    expect(body).toHaveClass('pt-9');
    expect(body).not.toHaveClass('pt-6');
  });

  it('keeps the 60px header row without a back button so content lines up across steps', () => {
    render(
      <FlowLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.queryByTestId('flow-back')).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveClass('min-h-15');
    expect(screen.getByRole('banner')).toHaveTextContent('Title');
  });

  it('pins a tab root CTA with the keyboard-aware cushion', () => {
    render(
      <FlowLayout tabRoot title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
  });

  // The docked bar draws over the page at `z-60` and reaches the screen edge, so a CTA at the
  // bottom is UNDER it. A pushed step is not exempt: Send's amount step is pushed and still lives
  // inside TabLayout. Dropping it to the bottom on the page's shape alone bet on `data-hide-navbar`
  // being raised by someone else, and on the frames where that bet lost, the bar swallowed every
  // click on the CTA (e2e: a visible, enabled, stable button, 30s of intercepted clicks). The
  // cushion is unconditional now, and `body[data-hide-navbar]` is what collapses it, in CSS.
  it('keeps a pushed page CTA clear of the docked bar, collapsing only when the bar is down', () => {
    render(
      <FlowLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
    expect(footer?.getAttribute('data-navbar-cushion')).toBe('true');
    // The flow footer snaps its cushion (the slide animates it), so it opts out of the padding transition.
    expect(footer).toHaveAttribute('data-flow-footer');
  });

  it("exempts a flow footer from main.css's cushion padding transition", () => {
    const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');
    expect(css).toMatch(/\[data-navbar-cushion='true'\]\[data-flow-footer\]\s*\{\s*transition:\s*none;/);
  });

  // The keyboard raises `data-hide-navbar` too, but only after a round trip through two components'
  // state — a frame or two AFTER the keyboard inset has already moved the page. Reading the flag
  // here made the cushion a second, later reflow, so the CTA rode the keyboard down and then hopped
  // back up by 3rem. The cushion is a function of `--keyboard-height` alone now, so both land in
  // the same frame and the CTA makes one move.
  it('keys its cushion on --keyboard-height, not on a React read of the navbar flag', () => {
    document.body.setAttribute('data-hide-navbar', '');
    try {
      render(
        <FlowLayout tabRoot title="Title" footer={<button>cta</button>}>
          <p>content</p>
        </FlowLayout>
      );

      expect(screen.getByText('cta').parentElement).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
    } finally {
      document.body.removeAttribute('data-hide-navbar');
    }
  });

  it.each([
    ['a pushed step', false],
    ['a tab root', true]
  ])('insets %s CTA to the page margin', (_, tabRoot) => {
    render(
      <FlowLayout tabRoot={tabRoot} title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement!;
    expect(footer).toHaveAttribute('data-navbar-cushion', 'true');
    expect(footer).toHaveClass('px-4');
  });

  it('puts a close button top right that calls onClose', () => {
    const onClose = jest.fn();
    render(
      <FlowLayout title="Processing" onClose={onClose} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    fireEvent.click(screen.getByTestId('flow-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('flow-back')).not.toBeInTheDocument();
  });
});
