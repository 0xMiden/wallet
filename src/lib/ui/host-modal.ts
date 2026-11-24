import { useRef } from 'react';

// One paint tier lets portal insertion order agree with Radix's modal registration order.
export const HOST_MODAL_LAYER = 'z-80';

function availableTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target?.isConnected && !target.closest('[data-slot="drawer-content"][data-state="closed"], [inert], [hidden]')
  );
}

export function useImperativeModalFocus() {
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      fallback.current = opener.current?.closest<HTMLElement>('[data-focus-fallback]') ?? null;
    },
    restore: (event: Event) => {
      event.preventDefault();
      if (document.activeElement === null || document.activeElement === document.body) {
        const target = availableTarget(opener.current) ? opener.current : fallback.current;
        if (availableTarget(target)) target.focus({ preventScroll: true });
      }
      opener.current = null;
      fallback.current = null;
    }
  };
}
