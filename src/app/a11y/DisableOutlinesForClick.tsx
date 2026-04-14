import { FC, useEffect } from 'react';

import styles from './DisableOutlinesForClick.module.css';

const TAB_KEY_CODE = 'Tab';
const CLASS_NAME = styles['focus-disabled']!;

/**
 * A nifty little class that maintains event handlers to add a class
 * to the container element when entering "mouse mode" (on a `mousedown` or `touchstart` event)
 * and remove it when entering "keyboard mode" (on a `tab` key `keydown` event)
 */
const DisableOutlinesForClick: FC = () => {
  useEffect(() => {
    const container = document.documentElement;
    container.addEventListener('mousedown', handlePointerDown);
    container.addEventListener('touchstart', handlePointerDown);

    return reset;

    function handlePointerDown() {
      reset();
      container.classList.add(CLASS_NAME);
      container.addEventListener('keydown', handleKeyDown);
    }

    function handleKeyDown(evt: KeyboardEvent) {
      if (evt.key === TAB_KEY_CODE) {
        reset();
        container.addEventListener('mousedown', handlePointerDown);
        container.addEventListener('touchstart', handlePointerDown);
      }
    }

    function reset() {
      container.classList.remove(CLASS_NAME);
      container.removeEventListener('keydown', handleKeyDown);
      container.removeEventListener('mousedown', handlePointerDown);
      container.removeEventListener('touchstart', handlePointerDown);
    }
  }, []);

  return null;
};

export default DisableOutlinesForClick;
