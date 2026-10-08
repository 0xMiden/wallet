import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TabHeader } from './TabHeader';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// framer-motion's `AnimatePresence` renders the children it saved in its own state, and when an exit
// finishes it re-renders a saved copy (`setRenderedChildren(pendingPresentChildren.current)`) that can
// carry older props than the page's latest render: on a busy main thread the title's exit lands after
// the input's commit and puts the field back as it was. This stub holds every child at the FIRST
// element it saw for its key, the worst case of that lag, so a field that takes its value and handlers
// from the element itself shows what the stale copy carried.
jest.mock('framer-motion', () => {
  const react = require('react');
  return {
    AnimatePresence: function StaleAnimatePresence({ children }: { children?: React.ReactNode }) {
      const saved = react.useRef(new Map());
      const shown = react.Children.toArray(children).map((child: React.ReactElement) => {
        if (!saved.current.has(child.key)) saved.current.set(child.key, child);
        return saved.current.get(child.key);
      });
      return react.createElement(react.Fragment, null, shown);
    },
    motion: new Proxy(
      {},
      {
        get: (_target: unknown, tag: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          react.forwardRef(({ children, initial, animate, exit, transition, ...rest }: any, ref: unknown) =>
            react.createElement(tag, { ...rest, ref }, children)
          )
      }
    ),
    useReducedMotion: () => false
  };
});

const URL_TYPED = 'http://10.0.2.2:8123/alpha/';

function Explore({ onSubmit }: { onSubmit: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <TabHeader
      title="Explore"
      actions={<button onClick={() => setOpen(true)}>search</button>}
      search={{
        open,
        value: query,
        onChange: setQuery,
        placeholder: 'Search',
        onSubmit: () => onSubmit(query),
        'data-testid': 'hero-search'
      }}
    />
  );
}

describe('TabHeader search behind a stale AnimatePresence copy', () => {
  it('shows what was typed and submits it, not the value the saved copy carried', () => {
    const onSubmit = jest.fn();
    render(<Explore onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('search'));
    const field = screen.getByTestId('hero-search');
    fireEvent.change(field, { target: { value: URL_TYPED } });

    expect(screen.getByTestId('hero-search')).toHaveValue(URL_TYPED);
    fireEvent.keyDown(screen.getByTestId('hero-search'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(URL_TYPED);
  });
});
