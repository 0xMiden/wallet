export { clearLegacyAnalyticsStorage } from './legacy-cleanup';
export { beginFlow, classifyError } from './report-flow';
export type { FlowHandle } from './report-flow';
// `useRouteDwell` is deliberately NOT re-exported, so call sites import it from
// its own module. Component tests mock this barrel to capture `beginFlow`, and
// a hook reached through it would be mocked away with everything else — the
// dwell gate would silently stop existing in exactly the tests written to prove
// a swiped-past pane reports nothing.
export {
  createStepProgressionTracker,
  MAX_REPEAT_EVENTS_PER_STEP_VISIT,
  MAX_STEP_EVENTS_PER_FLOW
} from './step-progression';
export type { StepProgressionTracker, StepProgressionTrackerOptions } from './step-progression';
export type { TelemetryErrorKind, TelemetryFlow, TelemetryStep, TelemetryStepAction } from './types';
