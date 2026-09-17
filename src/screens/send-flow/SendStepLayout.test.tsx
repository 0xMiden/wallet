import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SendStepLayout } from './SendStepLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({ IconName: { BackArrow: 'back-arrow' }, Icon: () => <svg /> }));

describe('SendStepLayout', () => {
  it('renders the title, accessory, content, footer, and a back button that calls onBack', () => {
    const onBack = jest.fn();
    render(
      <SendStepLayout title="Title" titleAccessory={<span>chip</span>} onBack={onBack} footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('chip')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-step-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('styles back as a nav button with the Send accent', () => {
    render(
      <SendStepLayout title="Title" onBack={jest.fn()} footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    expect(screen.getByTestId('send-step-back')).toHaveClass('bg-surface-nav-button');
  });

  it('keeps the back row without a back button so titles line up across steps', () => {
    const { container } = render(
      <SendStepLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    expect(screen.queryByTestId('send-step-back')).not.toBeInTheDocument();
    expect(container.querySelector('.h-12')).toBeInTheDocument();
  });

  it('pins the footer with the mobile cushion and no navbar-collapse hook', () => {
    render(
      <SendStepLayout title="Title" footer={<button>cta</button>}>
        <p>content</p>
      </SendStepLayout>
    );

    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
    expect(footer?.hasAttribute('data-navbar-cushion')).toBe(false);
  });

  it('drops the CTA to the bottom when the tab bar is hidden', () => {
    document.body.setAttribute('data-hide-navbar', '');
    try {
      render(
        <SendStepLayout title="Title" footer={<button>cta</button>}>
          <p>content</p>
        </SendStepLayout>
      );

      const footer = screen.getByText('cta').parentElement;
      expect(footer).toHaveClass('pb-4');
      expect(footer?.className).not.toContain('4rem');
    } finally {
      document.body.removeAttribute('data-hide-navbar');
    }
  });
});
