/**
 * @jest-environment node
 */
import { CONFIRM_ACTIONS } from './confirm-actions';
import { ConfirmPageSelectors } from '../../../src/app/ConfirmPage.selectors';

it('names only test ids the confirm page renders', () => {
  const rendered = new Set<string>(Object.values(ConfirmPageSelectors));
  for (const [kind, ids] of Object.entries(CONFIRM_ACTIONS)) {
    expect({ kind, approve: rendered.has(ids.approve), decline: rendered.has(ids.decline) }).toEqual({
      kind,
      approve: true,
      decline: true
    });
  }
});
