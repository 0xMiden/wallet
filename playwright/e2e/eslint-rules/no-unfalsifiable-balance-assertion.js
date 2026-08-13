/**
 * Reject balance assertions that cannot fail.
 *
 * `expect(balance).toBeGreaterThan(0)` and `waitForBalanceAbove(0, ...)` both pass
 * the moment ANY token of ANY faucet is non-zero — including a balance that was
 * already non-zero before the transfer under test, a credit in the WRONG token, or
 * an unconsumed note that was never actually claimed. A spec built on them stays
 * green through the exact bugs it was written to catch.
 *
 * Use the symbol-aware, exact base-unit helpers instead:
 *   playwright/e2e/helpers/balance-truth.ts  — vaultBalance / pendingNoteTotal / waitForVaultBalance
 *   playwright/e2e/helpers/assertions.ts     — snapshotTransfer / assertTransfer / assertConservation
 *
 * AST-based on purpose: the two helper files above quote these exact patterns in
 * their doc comments to explain the ban, and a grep-based gate flags its own
 * documentation.
 */

/** `0`, `0n`, `0.0` — every literal spelling of "above nothing". */
function isZeroLiteral(node) {
  if (!node || node.type !== 'Literal') return false;
  if (typeof node.value === 'number') return node.value === 0;
  if (typeof node.value === 'bigint') return node.value === 0n;
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow balance assertions whose threshold is zero, which cannot fail'
    },
    schema: [],
    messages: {
      toBeGreaterThanZero:
        'toBeGreaterThan(0) is not a balance assertion — it passes for the wrong token, the wrong amount, ' +
        'or a balance that was already non-zero. Assert an exact base-unit amount with ' +
        'assertTransfer/vaultBalance from playwright/e2e/helpers.',
      waitForBalanceAboveZero:
        'waitForBalanceAbove(0) resolves as soon as anything is non-zero, so it neither waits for nor ' +
        'checks the transfer under test. Use waitForVaultBalance(page, symbol, expectedBaseUnits) from ' +
        'playwright/e2e/helpers/balance-truth.'
    }
  },

  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;

        // expect(x).toBeGreaterThan(0) / expect(x, 'why').toBeGreaterThan(0)
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'toBeGreaterThan' &&
          isZeroLiteral(node.arguments[0])
        ) {
          context.report({ node, messageId: 'toBeGreaterThanZero' });
          return;
        }

        // wallet.waitForBalanceAbove(0, ...) or a bare waitForBalanceAbove(0, ...)
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
              ? callee.property.name
              : null;

        if (name === 'waitForBalanceAbove' && isZeroLiteral(node.arguments[0])) {
          context.report({ node, messageId: 'waitForBalanceAboveZero' });
        }
      }
    };
  }
};
