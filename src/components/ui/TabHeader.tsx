import React, { FC, ReactNode } from 'react';

import { AnimatePresence, motion, type Transition } from 'framer-motion';

import { IconName } from 'app/icons/v2';
import { durations, easings, useMotion, useSprings } from 'lib/animation';

import { HeaderRule } from './HeaderRule';
import { IconButton } from './IconButton';
import { SearchInput } from './SearchInput';

export interface TabHeaderProps {
  title: string;
  /** Extra action buttons rendered on the right of the title. */
  actions?: ReactNode;
  /**
   * In-header search. While `open`, the field takes the title's place in the
   * same row, so the page below keeps its position.
   */
  search?: {
    open: boolean;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** Enter / the keyboard's go key, e.g. to open a typed URL. */
    onSubmit?: () => void;
    /** Escape, e.g. to close the search. */
    onEscape?: () => void;
    /** `'url'` for a field that also takes a URL (URL keyboard, go key, no autocorrect). */
    inputMode?: 'text' | 'url' | 'search';
    /** Test id of the field's input. */
    'data-testid'?: string;
  };
}

/**
 * Bare icon button for the header's action group: a 24px glyph in a 44px hit area, built on the
 * design system's `IconButton`. `active` renders the accent-colored selected state (e.g. the
 * search icon while search is open) and sets `aria-pressed`, so this action always reads as a
 * toggle rather than a one-shot button.
 */
export const TabHeaderAction: FC<{
  label: string;
  icon: IconName;
  active?: boolean;
  onClick: () => void;
  'data-testid'?: string;
}> = ({ label, icon, active = false, onClick, 'data-testid': dataTestId }) => (
  <IconButton icon={icon} label={label} active={active} onClick={onClick} data-testid={dataTestId} />
);

/**
 * Header for top-level tab pages (Activity, Explore, Settings): page title on
 * the left, any `actions` on the right, then a 4px rounded rule on `fill` inset
 * to the page margin.
 *
 * The settings gear that used to live here is gone — Settings is a primary
 * bottom-nav destination now, so a gear on the very screens that show that
 * tab was a duplicate affordance.
 */
export const TabHeader: FC<TabHeaderProps> = ({ title, actions, search }) => {
  const searchOpen = search?.open === true;

  // Movement (position, scale) rides the shared spring; opacity gets its own
  // tween, so a fade never feels like it's being dragged by the spring's
  // physics. Both branches collapse to an instant swap under reduced motion —
  // `useSprings`/`useMotion` do that once, here.
  const springs = useSprings();
  const fade = useMotion({ duration: durations.fast, ease: easings.easeOutCubic });
  const transition: Transition = { default: springs.snappy, opacity: fade };

  return (
    <>
      <header className="shrink-0 px-4 py-3 flex h-15 items-center justify-between gap-3">
        <AnimatePresence initial={false} mode="popLayout">
          {searchOpen && search ? (
            <motion.div
              key="search"
              data-testid="tab-header-search"
              className="min-w-0 flex-1"
              // The field grows in from just shy of full size, slightly offset toward
              // the search icon it replaces (on the header's right edge) — closing
              // retraces the same path back toward the icon, not a plain fade.
              initial={{ opacity: 0, scale: 0.96, x: 6 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.96, x: 6 }}
              transition={transition}
            >
              <SearchInput
                size="sm"
                className="w-full"
                value={search.value}
                onChange={search.onChange}
                placeholder={search.placeholder}
                onSubmit={search.onSubmit}
                onEscape={search.onEscape}
                inputMode={search.inputMode}
                data-testid={search['data-testid']}
                autoFocus
              />
            </motion.div>
          ) : (
            <motion.h1
              key="title"
              data-testid="tab-header-title"
              className="min-w-0 truncate text-title-tab text-ink"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              transition={transition}
            >
              {title}
            </motion.h1>
          )}
        </AnimatePresence>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <HeaderRule className="mx-4" />
    </>
  );
};

export default TabHeader;
