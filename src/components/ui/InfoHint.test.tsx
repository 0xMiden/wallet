import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { reducedMotionTransition, springs } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

import { InfoHint } from './InfoHint';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

jest.mock('app/icons/v2', () => ({
  IconName: { Information: 'information' },
  Icon: ({ name }: { name: string }) => <svg data-testid="icon" data-name={name} />
}));

// framer-motion's presence machinery is not what this component is about: swap it for a plain
// div that surfaces the transition, and render children unconditionally inside AnimatePresence
// so an exit never leaves a bubble behind in the DOM.
let mockReduceMotion = false;
jest.mock('framer-motion', () => ({
  __esModule: true,
  useReducedMotion: () => mockReduceMotion,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, transition, ...rest }: any) => (
      <div data-transition={JSON.stringify(transition ?? null)} {...rest}>
        {children}
      </div>
    )
  }
}));

const renderHint = (body = 'The exact fee depends on the transaction.') =>
  render(
    <InfoHint label="More information about Max network fee" data-testid="fee-hint">
      {body}
    </InfoHint>
  );

const trigger = () => screen.getByTestId('fee-hint');

describe('InfoHint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
  });

  it('renders a labelled button with the info glyph and no bubble until it is asked for', () => {
    renderHint();

    expect(trigger()).toHaveAttribute('aria-label', 'More information about Max network fee');
    expect(trigger().tagName).toBe('BUTTON');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'information');
    expect(screen.queryByText(/exact fee/)).not.toBeInTheDocument();
  });

  it('opens the bubble on tap, with a haptic', () => {
    renderHint();

    fireEvent.click(trigger());

    expect(screen.getByText('The exact fee depends on the transaction.')).toBeInTheDocument();
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('describes the trigger by the open bubble, so the note is read with its own row', () => {
    renderHint();

    fireEvent.click(trigger());

    const describedBy = trigger().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('The exact fee depends');
  });

  it('closes again on a second tap of the trigger', () => {
    renderHint();

    fireEvent.click(trigger());
    fireEvent.click(trigger());

    expect(screen.queryByText(/exact fee/)).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderHint();

    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText(/exact fee/)).not.toBeInTheDocument();
  });

  it('closes on a tap outside the bubble', () => {
    renderHint();

    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);

    expect(screen.queryByText(/exact fee/)).not.toBeInTheDocument();
  });

  it('springs the bubble in on the tab-bar spring', () => {
    renderHint();

    fireEvent.click(trigger());

    const bubble = screen.getByText(/exact fee/);
    expect(JSON.parse(bubble.getAttribute('data-transition') as string)).toEqual(springs.tabSwitch);
  });

  it('appears instantly when the user asks for reduced motion', () => {
    mockReduceMotion = true;
    renderHint();

    fireEvent.click(trigger());

    const transition = JSON.parse(screen.getByText(/exact fee/).getAttribute('data-transition') as string);
    expect(transition).toEqual(reducedMotionTransition);
  });
});
