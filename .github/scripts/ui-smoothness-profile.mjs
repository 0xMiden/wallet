/**
 * The noise floor the UI smoothness comment is judged against.
 *
 * This file is read only by the trusted comment workflow, which runs from the
 * default branch and never from the pull request. The measurement artifact
 * cannot supply a threshold: a pull request that could raise the floor could
 * hide a regression.
 *
 * `thresholdProvisional` stays true until the floor is measured on the CI
 * runner by benching one build against itself. Until then the comment reports
 * movements as measurements, not rulings. The 7.5% bound is tighter than the
 * gap between two same-build medians on a developer laptop (about 9%), taken
 * when a run was six Overview-to-Send swipes. The full pass has not been
 * re-measured, so the floor stays provisional. Re-measure on `ubuntu-latest`
 * and set `thresholdProvisional` to false.
 *
 * A run is `passes` walks from the first page to the last. Each walk is one
 * swipe per boundary. The reported number is the median of every swipe, so the
 * sample count is `passes` times one less than `pageNames`. This list is the
 * home carousel in `scripts/home-swipe-score.mjs` (`HOME_PATHS`); the two have
 * to stay the same length, because this file is what decides how many samples
 * a run must contain and the bench is what produces them.
 */
export const DEFAULT_PROFILE = Object.freeze({
  thresholdPct: 7.5,
  thresholdProvisional: true,
  passes: 6,
  pageNames: Object.freeze(['Overview', 'Send', 'Receive', 'Earn', 'Swap']),
  /** Trusted clicks on the overview copy control. The reported tap number is the slowest. */
  inpTaps: 6,
  /** Field Interaction to Next Paint bands, in milliseconds. */
  inpGoodMs: 200,
  inpPoorMs: 500,
  /** Scrolls of the overview list. Each scroll reports dropped-frame percent and p95 frame time. */
  listRuns: 3
});

/** Feel samples a judged run contains. A shorter run is refused. */
export function sampleCount(profile = DEFAULT_PROFILE) {
  return profile.passes * (profile.pageNames.length - 1);
}
