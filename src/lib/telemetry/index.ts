export { clearLegacyAnalyticsStorage } from './legacy-cleanup';
export { beginFlow, classifyError } from './report-flow';
export type { FlowHandle } from './report-flow';
// `useRouteDwell` is deliberately NOT re-exported, so call sites import it from
// its own module. Component tests mock this barrel to capture `beginFlow`, and
// a hook reached through it would be mocked away with everything else — the
// dwell gate would silently stop existing in exactly the tests written to prove
// a swiped-past pane reports nothing.
export type { TelemetryErrorKind, TelemetryFlow } from './types';
