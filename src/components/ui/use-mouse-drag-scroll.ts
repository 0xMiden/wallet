import { MouseEvent, PointerEvent, RefObject, useEffect, useRef } from 'react';

const DRAG_THRESHOLD = 6;

/** Add mouse panning to native overflow without taking over touch, wheel or keyboard scrolling. */
export function useMouseDragScroll(rowRef: RefObject<HTMLDivElement>, enabled: boolean) {
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    dragging: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const row = rowRef.current;
    return () => {
      const current = gesture.current;
      gesture.current = null;
      suppressClick.current = false;
      if (current && row?.hasPointerCapture(current.pointerId)) row.releasePointerCapture(current.pointerId);
    };
  }, [enabled, rowRef]);

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      suppressClick.current = false;
      const row = event.currentTarget;
      if (
        !enabled ||
        event.pointerType !== 'mouse' ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        row.scrollWidth <= row.clientWidth
      )
        return;
      gesture.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: row.scrollLeft,
        dragging: false
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (event.buttons !== 1) {
        finish(event);
        return;
      }
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          gesture.current = null;
          return;
        }
        current.dragging = true;
        suppressClick.current = true;
        // Capture only once a drag is committed: a click must keep its original button target.
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.currentTarget.scrollLeft = current.scrollLeft - dx;
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
      if (!gesture.current?.dragging) finish(event);
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      // A drag's compatibility click can arrive after pointerup/lostcapture. Keep its guard until
      // the next press; keyboard activation has detail=0 and must always remain available.
      if (suppressClick.current && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };
}
