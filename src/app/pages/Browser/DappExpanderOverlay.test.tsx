import React, { useState } from 'react';

import { act, render } from '@testing-library/react';

import { DappExpanderOverlay } from './DappExpanderOverlay';

type Keyframe = Record<string, string | number>;
const mockAnimations: {
  keyframes: Keyframe[];
  options: { easing: string; fill: string };
  onfinish: (() => void) | null;
}[] = [];
const mockEnv = { reduced: false, linear: true };

jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockEnv.reduced
}));
jest.mock('lib/animation', () => ({
  ...jest.requireActual('lib/animation'),
  supportsLinearEasing: () => mockEnv.linear
}));
jest.mock('lib/mobile/high-refresh-rate', () => ({ boostRefreshRate: jest.fn() }));

const CARD = { x: 282, y: 650, width: 104, height: 132 };
const SLOT = { x: 0, y: 121, width: 402, height: 753 };

function Harness({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(true);
  return shown ? (
    <DappExpanderOverlay
      sourceRect={CARD}
      targetRect={SLOT}
      snapshot="data:image/jpeg;base64,AAAA"
      origin="https://app.example"
      onDone={() => {
        onDone();
        setShown(false);
      }}
    />
  ) : null;
}

const overlay = () => document.querySelector('[data-testid="dapp-expander-overlay"]');

beforeEach(() => {
  mockAnimations.length = 0;
  mockEnv.reduced = false;
  mockEnv.linear = true;
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: (keyframes: Keyframe[], options: { easing: string; fill: string }) => {
      const animation = { keyframes, options, onfinish: null, cancel: jest.fn() };
      mockAnimations.push(animation);
      return animation;
    }
  });
});

it('animates only transform and opacity', () => {
  render(<Harness onDone={jest.fn()} />);

  expect(overlay()).toHaveStyle({ left: '0px', top: '121px', width: '402px', height: '753px' });
  const [animation] = mockAnimations;
  expect(animation?.keyframes.flatMap(Object.keys).every(key => ['transform', 'opacity', 'offset'].includes(key))).toBe(
    true
  );
  expect(animation?.keyframes[0]).toEqual({
    transform: `translate(282px, 529px) scale(${104 / 402})`,
    opacity: 0,
    offset: 0
  });
  expect(animation?.keyframes.at(-1)).toEqual({ transform: 'none', opacity: 1, offset: 1 });
  expect(animation?.options).toMatchObject({ easing: expect.stringMatching(/^linear\(/), fill: 'forwards' });
});

it('unmounts when its animation finishes', () => {
  const onDone = jest.fn();
  render(<Harness onDone={onDone} />);
  expect(overlay()).not.toBeNull();

  act(() => mockAnimations[0]?.onfinish?.());

  expect(onDone).toHaveBeenCalledTimes(1);
  expect(overlay()).toBeNull();
});

it.each([
  ['under reduced motion', { reduced: true, linear: true }],
  ['without linear() support', { reduced: false, linear: false }]
])('renders nothing %s', (_label, env) => {
  Object.assign(mockEnv, env);
  const onDone = jest.fn();
  render(<Harness onDone={onDone} />);

  expect(overlay()).toBeNull();
  expect(mockAnimations).toHaveLength(0);
  expect(onDone).toHaveBeenCalledTimes(1);
});
