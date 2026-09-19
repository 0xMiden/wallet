import React from 'react';

import { render, screen } from '@testing-library/react';

import OnboardingStepLayoutDefault, { OnboardingStepLayout } from './OnboardingStepLayout';

describe('OnboardingStepLayout', () => {
  it('exports the component as the default export', () => {
    expect(OnboardingStepLayoutDefault).toBe(OnboardingStepLayout);
  });

  it('opens the body on a 28px title, a muted subtitle and the aside, with no page header', () => {
    render(
      <OnboardingStepLayout
        data-testid="step"
        title="Choose your Guardian"
        description="Select an option below"
        aside={<button type="button">Learn more</button>}
      >
        <div data-testid="content" />
      </OnboardingStepLayout>
    );
    const title = screen.getByRole('heading', { level: 1, name: 'Choose your Guardian' });
    expect(title).toHaveClass('text-[28px]', 'font-extrabold', 'text-ink');
    expect(screen.getByText('Select an option below')).toHaveClass('text-[15px]', 'text-muted');
    expect(screen.getByRole('button', { name: 'Learn more' })).toBeInTheDocument();
    expect(screen.queryByTestId('page-back')).toBeNull();

    // The heading and the content share the scrolling body, with the 16px gutter.
    const body = screen.getByTestId('step').querySelector('[data-slot="body"]');
    expect(body).toHaveClass('px-4', 'overflow-y-auto');
    expect(body).toContainElement(title);
    expect(body).toContainElement(screen.getByTestId('content'));
  });

  it('pins the footer outside the body, stacked by default', () => {
    render(
      <OnboardingStepLayout data-testid="step" footer={<button type="button">Continue</button>}>
        <div />
      </OnboardingStepLayout>
    );
    const footer = screen.getByRole('button', { name: 'Continue' }).parentElement;
    expect(footer).toHaveAttribute('data-slot', 'footer');
    expect(footer).toHaveClass('flex-col');
    expect(screen.getByTestId('step').querySelector('[data-slot="body"]')).not.toContainElement(footer);
  });

  it('draws no heading block when there is nothing to head the step with', () => {
    render(
      <OnboardingStepLayout data-testid="step" footerLayout="row" footer={<button type="button">Go</button>}>
        <div />
      </OnboardingStepLayout>
    );
    expect(screen.getByTestId('step').querySelector('[data-slot="step-heading"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Go' }).parentElement).not.toHaveClass('flex-col');
  });
});
