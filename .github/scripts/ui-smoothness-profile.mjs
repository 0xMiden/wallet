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
 * movements as measurements, not rulings. The 15% bound is the gap between two
 * same-build medians on a developer laptop (about 9%), with room above it.
 * Re-measure on `ubuntu-latest` and set `thresholdProvisional` to false.
 */
export const DEFAULT_PROFILE = Object.freeze({
  thresholdPct: 15,
  thresholdProvisional: true,
  /** Swipes whose median is the reported number. A shorter run is not judged. */
  calibratedReps: 6
});
