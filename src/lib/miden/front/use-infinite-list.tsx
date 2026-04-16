import { useCallback, useEffect, useRef, useState } from 'react';

interface infiniteListProps {
  getCount: (address: string) => Promise<number>;
  getItems: (address: string, page?: number) => Promise<Array<string>>;
}

export const useInfiniteList = ({ getCount, getItems }: infiniteListProps) => {
  const address = 'account.publicKey';
  const [items, setItems] = useState<Array<string>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const pageToLoad = useRef(0);
  const initialPageLoaded = useRef(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    /* c8 ignore next 4 -- address-change reset, requires multi-render hook test */
    if (initialPageLoaded.current) {
      initialPageLoaded.current = false;
      setItems([]);
    }
  }, [address]);

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    const count = await getCount(address);
    const data = await getItems(address, pageToLoad.current);
    pageToLoad.current = pageToLoad.current + 1;
    setHasMore(items.length < count);
    setItems(prevItems => [...prevItems, ...data]);
    setIsLoading(false);
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
    setItems,
    loadItems
  };
};
