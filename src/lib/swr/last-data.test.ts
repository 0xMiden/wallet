import { renderHook } from '@testing-library/react';

import { useLastData } from './last-data';

type Props = { readKey: unknown[]; running: boolean; live: string | undefined };

const renderLastData = (initialProps: Props) =>
  renderHook(({ readKey, running, live }: Props) => useLastData(readKey, running, live), { initialProps });

describe('useLastData', () => {
  it('returns the live data while the read runs', () => {
    const { result, rerender } = renderLastData({ readKey: ['read', 'a'], running: true, live: 'first' });
    expect(result.current).toBe('first');

    rerender({ readKey: ['read', 'a'], running: true, live: 'second' });
    expect(result.current).toBe('second');
  });

  it('returns the last data for the same key while the read does not run', () => {
    const { result, rerender } = renderLastData({ readKey: ['read', 'a'], running: true, live: 'first' });

    rerender({ readKey: ['read', 'a'], running: false, live: undefined });
    expect(result.current).toBe('first');
  });

  it('returns nothing for another key while the read does not run', () => {
    const { result, rerender } = renderLastData({ readKey: ['read', 'a'], running: true, live: 'first' });

    rerender({ readKey: ['read', 'b'], running: false, live: undefined });
    expect(result.current).toBeUndefined();
  });
});
