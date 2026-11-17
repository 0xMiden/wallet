export function heldReviewFailureFlags(message: string) {
  return {
    testTimeout: false,
    locatorTimeout: false,
    expectation: false,
    assertion: false,
    browserClosed: false,
    strictLocator: false
  };
}
