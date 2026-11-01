import React from 'react';

import { render } from '@testing-library/react';
import InfiniteScroll from 'react-infinite-scroller';

describe('InfiniteScroll null-ref handling', () => {
  it('ignores a queued scroll event after its content element is gone', () => {
    const scrollParent = document.createElement('div');
    const addEventListener = jest.spyOn(scrollParent, 'addEventListener');
    const view = render(
      <InfiniteScroll
        getScrollParent={() => scrollParent}
        hasMore
        initialLoad={false}
        loadMore={() => undefined}
        useWindow={false}
      >
        <div />
      </InfiniteScroll>
    );
    const scrollListener = addEventListener.mock.calls.find(([type]) => type === 'scroll')?.[1];

    view.unmount();
    addEventListener.mockRestore();

    expect(scrollListener).toBeDefined();
    expect(() => {
      if (typeof scrollListener === 'function') {
        scrollListener(new Event('scroll'));
      } else {
        scrollListener?.handleEvent(new Event('scroll'));
      }
    }).not.toThrow();
  });
});
