import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SendStepLayout } from 'screens/send-flow/SendStepLayout';

import { FlowLayout } from './FlowLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({
  IconName: { ChevronLeft: 'chevron-left', Close: 'close' },
  // Keep name and className: the glyph and its colour are what the back assertions check, and a
  // mock that drops them makes those assertions unfalsifiable.
  Icon: ({ name, className }: { name: string; className?: string }) => <svg data-name={name} className={className} />
}));

describe('FlowLayout', () => {
  it('renders the title, accessory, content, footer, and a back button that calls onBack', () => {
    const onBack = jest.fn();
    render(
      <FlowLayout title="Title" titleAccessory={<span>chip</span>} onBack={onBack} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('chip')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('styles back as a bare ink chevron, never the flow accent', () => {
    // Flow accents are under 3:1 on white, so the spec keeps them off text and the back chevron.
    // The color lives on the IconButton itself (a `bare` IconButton is always `ink`) and the
    // glyph inherits it through `fill="currentColor"` — same pattern PageHeader.test.tsx checks.
    render(
      <SendStepLayout title="Title" onBack={jest.fn()} footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    const back = screen.getByTestId('flow-back');
    expect(back).not.toHaveClass('bg-fill');
    expect(back).not.toHaveClass('bg-fill');
    expect(back).toHaveClass('text-ink');
    expect(back).not.toHaveClass('text-accent-send');
    const glyph = back.querySelector('svg');
    expect(glyph).toHaveAttribute('data-name', 'chevron-left');
  });

  it('keeps the 52px header row without a back button so content lines up across steps', () => {
    render(
      <FlowLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.queryByTestId('flow-back')).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveClass('h-13');
    expect(screen.getByRole('banner')).toHaveTextContent('Title');
  });

  it('pins a tab root CTA with the keyboard-aware cushion and no navbar-collapse hook', () => {
    render(
      <FlowLayout tabRoot title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
    expect(footer?.hasAttribute('data-navbar-cushion')).toBe(false);
  });

  it('drops a pushed page CTA to the bottom, with no tab bar under it to clear', () => {
    render(
      <FlowLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-4');
    expect(footer?.className).not.toContain('4rem');
  });

  // The keyboard raises `data-hide-navbar` too, but only after a round trip through two components'
  // state — a frame or two AFTER the keyboard inset has already moved the page. Reading the flag
  // here made the cushion a second, later reflow, so the CTA rode the keyboard down and then hopped
  // back up by 3rem. The cushion is a function of `--keyboard-height` alone now, so both land in
  // the same frame and the CTA makes one move.
  it('does not re-read the navbar flag, so the keyboard moves the CTA once', () => {
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
