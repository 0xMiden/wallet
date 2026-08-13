/**
 * Reject assertions that only run when the feature already worked.
 *
 * The shape this catches:
 *
 *   const visible = await sendFlow.isVisible().catch(() => false);
 *   if (visible) {
 *     expect(somethingAboutSendFlow).toBeTruthy();
 *   }
 *
 * If the send flow fails to render, the branch is skipped, no assertion runs, and
 * the test reports PASS. The condition has silently become the feature check, and
 * the only outcome it can produce is green. An `else` branch does not save it
 * either — both arms passing means the spec asserts "one of two things happened",
 * which is the union of working and broken.
 *
 * The fix is to decide what the spec is about and assert it unconditionally:
 * `await expect(sendFlow).toBeVisible()` first, then assert the behaviour. If a
 * branch genuinely cannot be predicted, the spec should skip explicitly
 * (`test.skip(cond, 'why')`) so the report says "skipped", not "passed".
 */

/** The root of every assertion chain: the `expect(...)` call itself. */
function isExpectCall(node) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'expect';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow expect() inside an if/else branch, where a skipped branch reports as a pass'
    },
    schema: [],
    messages: {
      conditionalExpect:
        'expect() inside an if/else branch cannot fail when the branch is not taken — the test reports PASS ' +
        'for a feature that never rendered. Assert the precondition unconditionally, or skip explicitly with ' +
        'test.skip(condition, reason).'
    }
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!isExpectCall(node)) return;

        // Walk outwards; report if we entered from a branch body rather than from
        // the condition being tested. Stops at a function boundary so an assertion
        // inside a callback defined in a branch is judged on its own body.
        let child = node;
        let parent = node.parent;
        while (parent) {
          if (
            parent.type === 'FunctionDeclaration' ||
            parent.type === 'FunctionExpression' ||
            parent.type === 'ArrowFunctionExpression'
          ) {
            return;
          }
          if (parent.type === 'IfStatement' && (child === parent.consequent || child === parent.alternate)) {
            context.report({ node, messageId: 'conditionalExpect' });
            return;
          }
          child = parent;
          parent = parent.parent;
        }
      }
    };
  }
};
