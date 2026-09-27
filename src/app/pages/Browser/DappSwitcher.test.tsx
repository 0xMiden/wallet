import React from 'react';

import { render, screen } from '@testing-library/react';

import { DappSwitcher } from './DappSwitcher';

const mockSessionStates = [
  { session: { id: 'session-1', url: 'https://app.example/', origin: 'https://app.example', title: 'Example' } }
];

jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ sessionStates: mockSessionStates, restore: jest.fn(), close: jest.fn() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({ getSnapshot: () => undefined }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

// motion.div as a plain div that reports its `layout` mode.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    motion: {
      div: ReactActual.forwardRef(
        (
          {
            children,
            layout,
            initial,
            animate,
            exit,
            transition,
            ...rest
          }: Record<string, unknown> & { children?: React.ReactNode },
          ref: React.Ref<HTMLDivElement>
        ) => (
          <div ref={ref} data-layout={String(layout)} {...rest}>
            {children}
          </div>
        )
      )
    }
  };
});

describe('DappSwitcher', () => {
  // A bare `layout` would scale a card on any render that changed its size, drawing its corners, shadow
  // and contents stretched for the spring; the reflow when a card closes only needs to move it.
  it('animates each card by position only, so a resize never scales it', () => {
    render(<DappSwitcher open onClose={jest.fn()} />);

    // Exact value: bare `layout` stringifies to 'true', so a not-'position' check alone proves nothing.
    expect(screen.getByRole('listitem')).toHaveAttribute('data-layout', 'position');
  });
});
