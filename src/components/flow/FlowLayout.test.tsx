import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { FlowLayout } from './FlowLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({
  IconName: { BackArrow: 'back-arrow', Close: 'close' },
  // Keep className: the flow's accent reaches the glyph through it, and a mock that drops it
  // makes every accent assertion in this suite unfalsifiable.
  Icon: ({ className }: { className?: string }) => <svg className={className} />
}));

describe('FlowLayout', () => {
  it('renders the title, accessory, content, footer, and a back button that calls onBack', () => {
    const onBack = jest.fn();
    render(
      <FlowLayout
        accent="send"
        title="Title"
        titleAccessory={<span>chip</span>}
        onBack={onBack}
        footer={<button>cta</button>}
      >
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('chip')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('styles back as a bare chevron with the Send accent', () => {
    const { rerender } = render(
      <FlowLayout accent="send" title="Title" onBack={jest.fn()} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const back = screen.getByTestId('flow-back');
    expect(back).not.toHaveClass('bg-surface-nav-button');
    // The glyph is the only thing the frame's accent colours, so assert it rather than the shell.
    expect(back.querySelector('svg')).toHaveClass('text-accent-send');

    rerender(
      <FlowLayout title="Title" onBack={jest.fn()} footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );
    expect(screen.getByTestId('flow-back').querySelector('svg')).toHaveClass('text-primary-500');
  });

  it('keeps the 52px header row without a back button so content lines up across steps', () => {
    render(
      <FlowLayout accent="send" title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(screen.queryByTestId('flow-back')).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveClass('h-13');
    expect(screen.getByRole('banner')).toHaveTextContent('Title');
  });

  it('pins the footer with the mobile cushion and no navbar-collapse hook', () => {
    render(
      <FlowLayout accent="send" title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
    expect(footer?.hasAttribute('data-navbar-cushion')).toBe(false);
  });

  it('drops the CTA to the bottom when the tab bar is hidden', () => {
    document.body.setAttribute('data-hide-navbar', '');
    try {
      render(
        <FlowLayout accent="send" title="Title" footer={<button>cta</button>}>
          <p>content</p>
        </FlowLayout>
      );

      const footer = screen.getByText('cta').parentElement;
      expect(footer).toHaveClass('pb-4');
      expect(footer?.className).not.toContain('4rem');
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
