export { clearLegacyAnalyticsStorage } from './legacy-cleanup';
export { beginFlow, classifyError } from './report-flow';
export type { FlowHandle } from './report-flow';
// `useRouteDwell` and step-progression helpers are deliberately NOT re-exported,
// so call sites import them from their own modules. Component tests mock this
// barrel to capture `beginFlow`, and anything re-exported here widens the
// mocked frontend surface (`index.test.ts`).
export type { TelemetryErrorKind, TelemetryFlow, TelemetryStep, TelemetryStepAction } from './types';
