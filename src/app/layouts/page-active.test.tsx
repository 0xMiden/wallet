import React, { FC } from 'react';

import { render } from '@testing-library/react';

import { PageActiveContext, TabActiveContext, useTabShownAgain } from './page-active';

describe('useTabShownAgain', () => {
  let seen: boolean[] = [];
  const Probe: FC = () => {
    seen.push(useTabShownAgain());
    return null;
  };
  const pane = (shown: boolean) => (
    <TabActiveContext.Provider value={shown}>
      <Probe />
    </TabActiveContext.Provider>
  );
  const last = () => seen[seen.length - 1];

  beforeEach(() => {
    seen = [];
  });

  it('is false for a pane mounted on screen and while it stays there', () => {
    const { rerender } = render(pane(true));
    expect(last()).toBe(false);
    rerender(pane(true));
    expect(last()).toBe(false);
  });

  it('is false while the pane is hidden', () => {
    const { rerender } = render(pane(true));
    rerender(pane(false));
    expect(last()).toBe(false);
  });

  it('is true for the commit that shows the pane again, and false from the next one', () => {
    const { rerender } = render(pane(true));
    rerender(pane(false));
    rerender(pane(true));
    expect(last()).toBe(true);
    rerender(pane(true));
    expect(last()).toBe(false);
  });

  it('is never true outside a tab pane, or for a page a slide page uncovers', () => {
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    rerender(
      <PageActiveContext.Provider value={false}>
        <Probe />
      </PageActiveContext.Provider>
    );
    rerender(
      <PageActiveContext.Provider value={true}>
        <Probe />
      </PageActiveContext.Provider>
    );
    expect(seen).not.toContain(true);
  });
});
