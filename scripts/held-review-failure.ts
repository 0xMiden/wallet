export function heldReviewFailureFlags(message: string) {
  return {
    testTimeout: message.includes('Test timeout of'),
    locatorTimeout: message.includes('locator.') && message.includes('Timeout'),
    responseTimeout: message.includes('page.waitForResponse') && message.includes('Timeout'),
    expectation: message.includes('expect('),
    assertion: message.includes('AssertionError'),
    browserClosed: message.includes('Target page, context or browser has been closed'),
    strictLocator: message.includes('strict mode violation')
  };
}
