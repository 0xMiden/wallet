import React, { FC } from 'react';

import useSWR from 'swr';

import { PropsWithChildren } from 'lib/props-with-children';

interface AwaitFontsProps extends PropsWithChildren {
  name: string;
  weights: number[];
  className?: string;
}

const AwaitFonts: FC<AwaitFontsProps> = ({ name, weights, className, children }) => {
  useSWR([name, weights, className ?? ''], awaitFonts, {
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
  const applyClass = () => {
    const classNames = className.split(' ').filter(Boolean);
    if (classNames.length > 0) {
      document.body.classList.add(...classNames);
    }
  };

  // Native Font Loading API resolves once the matching `@font-face` has
  // delivered the requested weight. Those files are bundled rather than fetched
  // from a CDN, so this normally settles in a frame or two; the 5s race stays
  // because a font that fails to decode would otherwise never resolve and would
  // hold the suspense boundary open for the whole session.
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
