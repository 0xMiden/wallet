import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as CheckIcon } from 'app/icons/v2/checkmark.svg';
import { Popover } from 'components/ui/Popover';
import { hapticSelection } from 'lib/mobile/haptics';
import { ActivityView } from 'lib/settings/constants';
import { cn } from 'lib/ui/util';

/** One labelled choice in the menu's view picker, with the i18n key of its name. */
const VIEW_CHOICES: { view: ActivityView; labelKey: string }[] = [
  { view: 'list', labelKey: 'activityViewList' },
  { view: 'groups', labelKey: 'activityViewGroups' }
];

/** The radio mark beside a view's name: the app's round check, filled once chosen. */
const RadioMark: React.FC<{ selected: boolean }> = ({ selected }) => (
  <span
    aria-hidden="true"
    className={cn(
      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border',
      selected ? 'border-accent-primary bg-accent-primary' : 'border-hairline'
    )}
  >
    {selected && <CheckIcon className="h-1.5 w-2 fill-pure-white" />}
  </span>
);

/** A bar of the thumbnail; the widths differ so the preview reads as text, not as a table. */
const Bar: React.FC<{ className?: string }> = ({ className }) => (
  <span className={cn('h-1.5 rounded-full bg-fill-pressed', className)} />
);

/**
 * What each view looks like, drawn rather than screenshotted so it follows the theme: the feed is
 * stacked lines, the groups view is a row per counterparty with its avatar.
 */
const Thumbnail: React.FC<{ view: ActivityView }> = ({ view }) =>
  view === 'list' ? (
    <>
      <Bar className="w-full" />
      <Bar className="w-3/4" />
      <Bar className="w-full" />
      <Bar className="w-2/3" />
    </>
  ) : (
    <>
      {[0, 1, 2].map(row => (
        <span key={row} className="flex items-center gap-1.5">
          <span className="h-3 w-3 shrink-0 rounded-full bg-fill-pressed" />
          <Bar className={row === 1 ? 'w-1/2' : 'w-3/4'} />
        </span>
      ))}
    </>
  );

interface ViewChoiceProps {
  view: ActivityView;
  label: string;
  selected: boolean;
  onSelect: (view: ActivityView) => void;
}

const ViewChoice: React.FC<ViewChoiceProps> = ({ view, label, selected, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    data-testid={`activity-view-${view}`}
    onClick={() => {
      if (selected) return;
      hapticSelection();
      onSelect(view);
    }}
    className={cn(
      'flex min-w-0 flex-1 flex-col items-center gap-2 rounded-2xl p-2',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset',
      selected && 'bg-fill'
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        'flex h-[72px] w-full flex-col justify-center gap-1.5 rounded-xl border bg-page px-2.5',
        selected ? 'border-accent-primary' : 'border-hairline'
      )}
    >
      <Thumbnail view={view} />
    </span>
    <span className="flex min-w-0 items-center gap-1.5">
      <RadioMark selected={selected} />
      <span className="truncate text-body-sm text-ink">{label}</span>
    </span>
  </button>
);

export interface ActivityViewMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  view: ActivityView;
  onViewChange: (view: ActivityView) => void;
}

/**
 * The Activity tab's view switcher, hanging off the header's round icon button: the two views as
 * labelled thumbnails with radio marks, and nothing else.
 *
 * It holds NO filters. The filter row lives where it always has, under the title in List view; the
 * Groups view has neither, because rolling the history up by counterparty IS the filtering there
 * (Brian, simulator review). One choice per menu, so the panel stays the size of that choice.
 */
export const ActivityViewMenu: React.FC<ActivityViewMenuProps> = ({ open, onClose, anchorRef, view, onViewChange }) => {
  const { t } = useTranslation();

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      align="end"
      aria-label={t('activityViewOptions')}
      screenKey="activity-view"
      data-testid="activity-view-menu"
    >
      {/* 12px all round rather than the 8px it took when a list sat under it: the thumbnails are
          the whole panel now, so their inset is the panel's own margin. */}
      <div role="radiogroup" aria-label={t('activityView')} className="flex gap-2 p-3">
        {VIEW_CHOICES.map(choice => (
          <ViewChoice
            key={choice.view}
            view={choice.view}
            label={t(choice.labelKey)}
            selected={view === choice.view}
            onSelect={next => {
              onViewChange(next);
              onClose();
            }}
          />
        ))}
      </div>
    </Popover>
  );
};

export default ActivityViewMenu;
