/** Why the startup eligibility lookup failed. A closed set, so a reason can be reported without free text. */
export const ELIGIBILITY_FAILURES = Object.freeze([
  'timeout',
  'network',
  'http_4xx',
  'http_5xx',
  'http_other',
  'bad_body',
  'version_mismatch',
  'not_configured',
  'no_document',
  'error'
] as const);
export type EligibilityFailure = (typeof ELIGIBILITY_FAILURES)[number];
