import { useCallback, useEffect, useRef, useState } from 'react';

interface infiniteListProps {
  getCount: (address: string) => Promise<number>;
  getItems: (address: string, page?: number) => Promise<Array<string>>;
}

export const useInfiniteList = ({ getCount, getItems }: infiniteListProps) => {
  const address = 'account.publicKey';
  const [items, setItems] = useState<Array<string>>([]);
  const [isLoading, setIsLoading] = useState(false);
  // The last load's failure, cleared when the next load starts; loadItems settles instead of rejecting, and a
  // failure stops paging (hasMore false) until a later loadItems() retries the page and succeeds.
  const [error, setError] = useState<unknown>(undefined);
  const pageToLoad = useRef(0);
  const initialPageLoaded = useRef(false);
  const [hasMore, setHasMore] = useState(true);
  // Set while a load runs, so a second call cannot start an overlapping load for the same page, as History's
  // loader refuses re-entry; a ref, because loadItems is memoised and would read a stale isLoading.
  const inFlight = useRef(false);

  useEffect(() => {
    /* c8 ignore next 4 -- address-change reset, requires multi-render hook test */
    if (initialPageLoaded.current) {
      initialPageLoaded.current = false;
      setItems([]);
    }
  }, [address]);

  const loadItems = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsLoading(true);
    setError(undefined);
    try {
      const count = await getCount(address);
      const data = await getItems(address, pageToLoad.current);
      pageToLoad.current = pageToLoad.current + 1;
      setHasMore(items.length < count);
      setItems(prevItems => [...prevItems, ...data]);
    } catch (e) {
      // Stop paging, as History's loader does: with hasMore still true an infinite scroller re-arms on every
      // render and would retry a failing page for the rest of the session.
      setError(e);
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  }, [address, getCount, getItems, items.length]);

  useEffect(() => {
    if (initialPageLoaded.current) {
      return;
    }
    pageToLoad.current = 0;

    loadItems();
    initialPageLoaded.current = true;
  }, [loadItems]);

  return {
    items,
    hasMore,
    isLoading,
    error,
    setItems,
    loadItems
  };
};
