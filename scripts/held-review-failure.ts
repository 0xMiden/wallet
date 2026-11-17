export function heldReviewFailureFlags(message: string) {
  return {
    testTimeout: false,
    locatorTimeout: false,
    responseTimeout: false,
    expectation: false,
    assertion: false,
    browserClosed: false,
    strictLocator: false
  };
}
