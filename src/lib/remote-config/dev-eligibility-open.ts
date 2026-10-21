/** True only when this Vite process is an explicit non-E2E development build that opted in. */
export function devEligibilityOpen(env: {
  MODE_ENV?: string;
  MIDEN_E2E_TEST?: string;
  MIDEN_ELIGIBILITY_OPEN?: string;
}): boolean {
  return env.MODE_ENV === 'development' && env.MIDEN_E2E_TEST !== 'true' && env.MIDEN_ELIGIBILITY_OPEN === 'true';
}
