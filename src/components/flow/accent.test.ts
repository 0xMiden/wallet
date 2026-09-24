import type { ITransactionType } from 'lib/miden/db/types';

import { accentForTransactionType, FlowAccent } from './accent';

// Every transaction type, so a type added to ITransactionType without a mapping here fails `yarn ts`.
const EXPECTED: Record<ITransactionType, FlowAccent> = {
  send: 'send',
  'bridged-send': 'send',
  consume: 'receive',
  'bridged-receive': 'receive',
  'earn-deposit': 'earn',
  'earn-withdraw': 'earn',
  swap: 'swap',
  execute: 'brand',
  'switch-guardian': 'brand',
  'replace-hot-key': 'brand',
  'update-procedure-threshold': 'brand'
};

describe('accentForTransactionType', () => {
  it.each(Object.entries(EXPECTED) as Array<[ITransactionType, FlowAccent]>)('colours a %s in %s', (type, accent) => {
    expect(accentForTransactionType(type)).toBe(accent);
  });

  it('colours an unknown type in the brand', () => {
    expect(accentForTransactionType(undefined)).toBe('brand');
  });
});
