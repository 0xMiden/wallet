// Recovery stays denied until the original-case contract is proved RED then implemented.
export function compactRecoveryIntent() {
  throw new Error('Original Compact recovery is not authorized');
}
export function assertCompactRecoveryFees() {
  throw new Error('Original Compact recovery fees are not authorized');
}
