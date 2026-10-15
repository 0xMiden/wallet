import { act, renderHook } from '@testing-library/react';

import { _resetGuardianRegistryForTest, setDocumentGuardians } from 'lib/miden-chain/guardian-registry';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { useGuardianOptions } from './useGuardianOptions';

let mockGuardianUrlOverride = '';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveGuardianUrl: () => mockGuardianUrlOverride
}));

const NEW = { id: 'new-one', name: 'New', operatedBy: 'New Co', location: 'EU', endpoint: 'https://new.example' };

beforeEach(() => {
  mockGuardianUrlOverride = '';
  _resetGuardianRegistryForTest();
});

afterAll(() => _resetGuardianRegistryForTest());

it('gives the bundled operators while the realm has no document list', () => {
  const { result } = renderHook(() => useGuardianOptions());

  expect(result.current.map(option => option.id)).toEqual(['open-zeppelin', 'gateway', 'lambda-class', 'kodax']);
});

it('keeps one array across renders, so a picker does not ping its options again', () => {
  const { result, rerender } = renderHook(() => useGuardianOptions());
  const first = result.current;

  rerender();

  expect(result.current).toBe(first);
});

it('replaces the options when a document list lands while the picker is open', () => {
  const { result } = renderHook(() => useGuardianOptions());

  act(() => setDocumentGuardians('testnet', [NEW]));

  expect(result.current).toEqual([NEW]);
});

it('keeps the options when a document for another network lands', () => {
  const { result } = renderHook(() => useGuardianOptions());
  const before = result.current.map(option => option.id);

  act(() => setDocumentGuardians('devnet', [NEW]));

  expect(result.current.map(option => option.id)).toEqual(before);
});

it('adds the developer endpoint after the document list', () => {
  mockGuardianUrlOverride = 'https://dev.guardian.test';
  setDocumentGuardians('testnet', [NEW]);

  const { result } = renderHook(() => useGuardianOptions());

  expect(result.current.map(option => option.id)).toEqual(['new-one', 'custom']);
});

it('gives the operators of a network the caller names, not the effective one', () => {
  const { result, rerender } = renderHook(() => useGuardianOptions(MIDEN_NETWORK_NAME.MAINNET));

  expect(result.current).toEqual([]);

  act(() => setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [NEW]));
  rerender();

  expect(result.current).toEqual([NEW]);
});
