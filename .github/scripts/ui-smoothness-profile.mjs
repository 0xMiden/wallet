/**
 * The noise floor the UI smoothness comment is judged against.
 *
 * This file is read only by the trusted comment workflow, which runs from the
 * default branch and never from the pull request. The measurement artifact
 * cannot supply a threshold: a pull request that could raise the floor could
 * hide a regression.
 *
 * Six fresh-profile runs of this build on ubuntu-latest (2026-10-20) put the
 * feel median between 46.8 and 66.2. The largest gap was 41%, so the feel
 * floor is 50%: low enough to catch a real move, high enough that a same-build
 * pair is not called one. The settings list moved at most 4.5% (dropped
 * frames) and not at all (p95 frame time), so its floor is 7.5%.
 * `thresholdProvisional` is false because that spread was measured on the
 * runner the job uses.
 *
 * A run is `passes` walks from the first page to the last. Each walk is one
 * swipe per boundary. The reported number is the median of every swipe, so the
 * sample count is `passes` times one less than `pageNames`. This list is the
 * home carousel in `scripts/home-swipe-score.mjs` (`HOME_PATHS`); the two have
 * to stay the same length, because this file is what decides how many samples
 * a run must contain and the bench is what produces them.
 */
export const DEFAULT_PROFILE = Object.freeze({
  /** Same-build feel medians on ubuntu-latest differed by up to 41%. */
  feelThresholdPct: 50,
  /** Same-build settings-list medians differed by at most 4.5%. */
  listThresholdPct: 7.5,
  thresholdProvisional: false,
  passes: 6,
  pageNames: Object.freeze(['Overview', 'Send', 'Receive', 'Earn', 'Swap']),
  /** Trusted clicks on the overview copy control. The reported tap number is the slowest. */
  inpTaps: 6,
  /** Field Interaction to Next Paint bands, in milliseconds. */
  inpGoodMs: 200,
  inpPoorMs: 500,
  /** Scrolls of the settings list. Each scroll reports dropped-frame percent and p95 frame time. */
  listRuns: 3
});

/** Feel samples a judged run contains. A shorter run is refused. */
export function sampleCount(profile = DEFAULT_PROFILE) {
  return profile.passes * (profile.pageNames.length - 1);
}
