import * as React from 'react';

import { logger } from 'shared/logger';

/** The value stored under `key` right now, or `fallback` when there is none or it does not parse. */
export const readLocalStorage = <T>(key: string, fallback: T): T => {
  try {
    const item = localStorage.getItem(key);

    return item ? JSON.parse(item) : fallback;
  } catch (error) {
    logger.error(`Failed to get item with key ${key} from local storage`, error);

    return fallback;
  }
};

// TODO: reuse in other places (eg. saving.ts & popup-mode/index.ts)
export const useLocalStorage = <T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] => {
  const [storedValue, setStoredValue] = React.useState<T>(() => readLocalStorage(key, initialValue));

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      logger.error('Failed to store item in local storage', error);
    }
  };

  return [storedValue, setValue];
};
