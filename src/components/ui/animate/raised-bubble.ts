/**
 * The raised bubble every tab-like control slides under the selected item: the bottom nav's
 * highlight, the top action bar's pill and the segmented control's selection. White with a soft
 * drop in light mode, lit `fill` in dark (the `raised` tokens), sinking to the pressed shadow while
 * its item is held — so the item carries `group`. Callers add only its inset.
 */
export const raisedBubbleClassName =
  'rounded-full bg-raised shadow-raised transition-shadow group-active:shadow-raised-pressed';
