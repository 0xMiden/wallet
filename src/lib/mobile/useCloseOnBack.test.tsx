import React from 'react';

import { render } from '@testing-library/react';

import { useCloseOnBack } from './useCloseOnBack';

// The real useMobileBackHandler over a recorded registry: every registration with its options and
// its own unregister spy, so a test sees which handler is live after a re-render.
const mockRegistrations: { handler: () => boolean | void; options: unknown; unregister: jest.Mock }[] = [];
jest.mock('./back-handler', () => ({
  registerMobileBackHandler: (handler: () => boolean | void, options: unknown) => {
    const unregister = jest.fn();
    mockRegistrations.push({ handler, options, unregister });
    return unregister;
  }
}));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => true }));

const Harness: React.FC<{ open: boolean; close: () => void }> = ({ open, close }) => {
  useCloseOnBack(open, close);
  return null;
};

const live = () => mockRegistrations.filter(r => r.unregister.mock.calls.length === 0);

beforeEach(() => {
  mockRegistrations.length = 0;
});

describe('useCloseOnBack', () => {
  it('passes the press while closed, and closes and consumes it in the overlay tier while open', () => {
    const close = jest.fn();
    const view = render(<Harness open={false} close={close} />);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.handler()).toBe(false);
    expect(close).not.toHaveBeenCalled();

    view.rerender(<Harness open close={close} />);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.options).toEqual({ overlay: true });
    expect(live()[0]!.handler()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls the latest close without registering again when only the callback's identity changes", () => {
    const first = jest.fn();
    const view = render(<Harness open close={first} />);
    const registered = mockRegistrations.length;

    const second = jest.fn();
    view.rerender(<Harness open close={second} />);
    expect(mockRegistrations).toHaveLength(registered);
    live()[0]!.handler();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
