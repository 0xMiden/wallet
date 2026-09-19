/**
 * How far above the viewport's bottom edge the peek tray sits: the height of the tab bar's footer
 * (`[data-tabbar-footer]`), which reaches the screen edge, so the tray rests just on top of the bar.
 *
 * The measurement is used as-is whenever there is one. The footer keeps its layout while the bar is
 * hidden (it fades, and the docked bar slides, but neither changes its height), so a positive
 * reading is always the bar's real height — the docked bar is 1 + 8 + 56 + max(8, safe − 16) px,
 * i.e. 73px without a home indicator and 83px on an iPhone that has one. With no footer mounted it
 * falls back to that iPhone height.
 */
export const FOOTER_HEIGHT_FALLBACK = 83;

export function resolveFooterClearance(measured: number | null | undefined): number {
  return measured && measured > 0 ? measured : FOOTER_HEIGHT_FALLBACK;
}
