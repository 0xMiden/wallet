import React, { FC } from 'react';

import useSWR from 'swr';

import { PropsWithChildren } from 'lib/props-with-children';

interface AwaitFontsProps extends PropsWithChildren {
  name: string;
  weights: number[];
  className: string;
}

const AwaitFonts: FC<AwaitFontsProps> = ({ name, weights, className, children }) => {
  useSWR([name, weights, className], awaitFonts, {
    suspense: true,
    shouldRetryOnError: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });

  return <>{children}</>;
};

export default AwaitFonts;

async function awaitFonts(args: [string, number[], string]) {
  const [name, weights, className] = args;
  const applyClass = () => document.body.classList.add(...className.split(' '));

  // Native Font Loading API resolves once Google Fonts (or any @font-face) has
  // delivered the requested weight. Fall back to whatever the browser has
  // after 5s so a slow CDN never blocks boot.
  if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
    try {
      await Promise.race([
        Promise.all(weights.map(weight => document.fonts.load(`${weight} 1em "${name}"`))),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    } catch (err) {
      console.error(err);
    }
  }

  applyClass();
  return null;
}
