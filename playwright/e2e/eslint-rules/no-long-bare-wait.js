/**
 * Reject long unconditional sleeps.
 *
 * `page.waitForTimeout(30_000)` is not a wait for anything — it is a bet that the
 * thing being waited on finishes in under 30s on every machine that will ever run
 * the suite. When the bet loses, the failure surfaces at some unrelated assertion
 * further down the spec, which is the most expensive kind of E2E failure to read.
 *
 * Short settles (<= 2000ms) are tolerated: they absorb a render tick rather than
 * standing in for a real condition. Anything longer must be expressed as a
 * condition — `expect.poll`, `waitForSelector`, `waitForFunction`, or one of the
 * polling helpers in playwright/e2e/helpers — so the timeout message says what
 * never happened.
 */

const MAX_BARE_WAIT_MS = 2000;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: `disallow waitForTimeout longer than ${MAX_BARE_WAIT_MS}ms in favour of waiting on a condition`
    },
    schema: [],
    messages: {
      longWait:
        'waitForTimeout({{ms}}) is a {{seconds}}s bet, not a wait. Poll the condition you actually need ' +
        '(expect.poll / waitForSelector / waitForFunction) so a failure reports what never happened. ' +
        `Bare sleeps up to ${MAX_BARE_WAIT_MS}ms are allowed for render settles.`
    }
  },

  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
              ? callee.property.name
              : null;
        if (name !== 'waitForTimeout') return;

        // Only literal durations are checkable. A computed duration is opaque here
        // and is left to review rather than guessed at.
        const [arg] = node.arguments;
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'number') return;
        if (arg.value <= MAX_BARE_WAIT_MS) return;

        context.report({
          node,
          messageId: 'longWait',
          data: { ms: String(arg.value), seconds: String(Math.round(arg.value / 100) / 10) }
        });
      }
    };
  }
};
