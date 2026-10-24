import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PanInfo } from 'framer-motion';

import { MORPH_TIMING } from 'lib/animation';
import type { DappSession } from 'lib/dapp-browser';

import { DappPeekCard } from './DappPeekCard';

type DragEnd = (event: unknown, info: PanInfo) => void;
const mockMotion: { onDrag?: DragEnd; onDragEnd?: DragEnd; exit?: unknown } = {};

jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return {
    ...jest.requireActual('framer-motion'),
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
            drag,
            dragDirectionLock,
            dragConstraints,
            dragElastic,
            dragMomentum,
            onDragStart,
            onDrag,
            onDragEnd,
            ...rest
          }: Record<string, unknown> & { children?: React.ReactNode; onDrag?: DragEnd; onDragEnd?: DragEnd },
          ref: React.Ref<HTMLDivElement>
        ) => {
          mockMotion.onDrag = onDrag;
          mockMotion.onDragEnd = onDragEnd;
          mockMotion.exit = exit;
          return (
            <div ref={ref} {...rest}>
              {children}
            </div>
          );
        }
      )
    }
  };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { Close: 'Close' } }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/dapp-browser', () => ({
  getDappDisplayName: (session: { title: string }) => session.title,
  getFallbackColor: () => '#123456',
  getFallbackLetter: () => 'E'
}));

const SESSION: DappSession = {
  id: 's1',
  url: 'https://app.example/',
  origin: 'https://app.example',
  title: 'Example',
  favicon: null,
  status: 'parked',
  openedAt: 0
};

const pan = (offset: { x: number; y: number }, velocity: { x: number; y: number }): PanInfo => ({
  point: { x: 0, y: 0 },
  delta: { x: 0, y: 0 },
  offset,
  velocity
});

function renderCard(props: Partial<React.ComponentProps<typeof DappPeekCard>> = {}) {
  const callbacks = { onCommitRestore: jest.fn(), onClose: jest.fn(), onShowAll: jest.fn() };
  const view = render(<DappPeekCard session={SESSION} stackIndex={0} overflowCount={2} {...callbacks} {...props} />);
  return { ...callbacks, ...view };
}

function release(offset: { x: number; y: number }, velocity: { x: number; y: number }) {
  act(() => {
    mockMotion.onDrag?.({}, pan(offset, velocity));
    mockMotion.onDragEnd?.({}, pan(offset, velocity));
  });
}

afterEach(() => jest.restoreAllMocks());

const chrome = () => Array.from(document.querySelectorAll<HTMLElement>('[data-peek-chrome]'));

it('keeps the card, close and show-all test ids', () => {
  renderCard();

  expect(screen.getByTestId('dapp-peek-card')).toHaveAttribute('data-dapp-id', 's1');
  expect(screen.getByTestId('dapp-peek-card-close')).toBeInTheDocument();
  expect(screen.getByTestId('dapp-peek-show-all')).toBeInTheDocument();
});

it('restores on tap with zero velocity', () => {
  const rect = new DOMRect(282, 650, 104, 132);
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  const { onCommitRestore } = renderCard();

  fireEvent.click(screen.getByTestId('dapp-peek-card'));

  expect(onCommitRestore).toHaveBeenCalledWith(rect, { x: 0, y: 0 });
});

it('restores on swipe up past 60 pt or 450 pt/s with the release velocity', () => {
  const { onCommitRestore } = renderCard();

  release({ x: 0, y: -61 }, { x: 10, y: -200 });
  release({ x: 0, y: -10 }, { x: 0, y: -451 });
  release({ x: 0, y: -10 }, { x: 0, y: -300 });

  expect(onCommitRestore.mock.calls.map(call => call[1])).toEqual([
    { x: 10, y: -200 },
    { x: 0, y: -451 }
  ]);
});

it('closes on swipe down', async () => {
  const { onClose, onCommitRestore } = renderCard();

  release({ x: 0, y: 61 }, { x: 0, y: 0 });
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onCommitRestore).not.toHaveBeenCalled();
});

it('fades the chrome in only when chromeVisible turns true', () => {
  const { rerender, onCommitRestore, onClose, onShowAll } = renderCard({ chromeVisible: false });
  expect(chrome()).toHaveLength(5);
  for (const element of chrome()) {
    expect(element.style.opacity).toBe('0');
    expect(element.style.transition).toBe('none');
  }
  expect(screen.getByTestId('dapp-peek-card').style.boxShadow).toBe('0 10px 28px rgba(15,23,42,0.2)');

  rerender(
    <DappPeekCard
      session={SESSION}
      stackIndex={0}
      overflowCount={2}
      chromeVisible
      onCommitRestore={onCommitRestore}
      onClose={onClose}
      onShowAll={onShowAll}
    />
  );

  for (const element of chrome()) {
    expect(element.style.opacity).toBe('1');
    expect(element.style.transition).toBe(`opacity ${MORPH_TIMING.chromeFadeMs}ms ease-out`);
  }
});

it('leaves instantly when exitInstantly is set', () => {
  renderCard();
  expect(mockMotion.exit).toEqual(expect.objectContaining({ y: 40 }));

  renderCard({ exitInstantly: true });

  expect(mockMotion.exit).toEqual({ opacity: 0, transition: { duration: 0 } });
});
