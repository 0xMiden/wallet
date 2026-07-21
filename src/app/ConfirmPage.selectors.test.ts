import { ConfirmPageSelectors } from './ConfirmPage.selectors';

// ConfirmPage.selectors is a pure, dependency-free TypeScript string enum used to
// tag the confirm-page action controls (connect / sign / decrypt / records /
// transaction / consume / bulk / deploy / private-notes / sign-data / assets /
// import-note / consumable-notes accept & reject buttons) with stable
// automation/testIDs. A string enum has no reverse mapping, so the compiled object
// is exactly the set of named string members. We exercise every exported member
// end-to-end: its exact value, the shape of the compiled enum object, and the
// string-enum invariants (no numeric reverse-mapping keys). This covers every line
// the enum emits.

describe('ConfirmPageSelectors', () => {
  // Verbatim expected mapping — one entry per source member (all 27).
  const EXPECTED: Record<string, string> = {
    ConnectAction_CancelButton: 'ConfirmPage/ConnectAction/CancelButton',
    ConnectAction_RetryButton: 'ConfirmPage/ConnectAction/RetryButton',
    ConnectAction_ConnectButton: 'ConfirmPage/ConnectAction/ConnectButton',
    SignAction_RejectButton: 'ConfirmPage/SignAction/RejectButton',
    SignAction_SignButton: 'ConfirmPage/SignAction/SignButton',
    DecryptAction_RejectButton: 'ConfirmPage/DecryptAction/RejectButton',
    DecryptAction_AcceptButton: 'ConfirmPage/DecryptAction/AcceptButton',
    RecordsAction_RejectButton: 'ConfirmPage/RecordsAction/RejectButton',
    RecordsAction_AcceptButton: 'ConfirmPage/RecordsAction/AcceptButton',
    TransactionAction_RejectButton: 'ConfirmPage/TransactionAction/RejectButton',
    TransactionAction_AcceptButton: 'ConfirmPage/TransactionAction/AcceptButton',
    ConsumeAction_RejectButton: 'ConfirmPage/ConsumeAction/RejectButton',
    ConsumeAction_AcceptButton: 'ConfirmPage/ConsumeAction/AcceptButton',
    BulkTransactionsAction_RejectButton: 'ConfirmPage/BulkTransactionsAction/RejectButton',
    BulkTransactionsAction_AcceptButton: 'ConfirmPage/BulkTransactionsAction/AcceptButton',
    DeployAction_RejectButton: 'ConfirmPage/DeployAction/RejectButton',
    DeployAction_AcceptButton: 'ConfirmPage/DeployAction/AcceptButton',
    RequestPrivateNotes_RejectButton: 'ConfirmPage/RequestPrivateNotes/RejectButton',
    RequestPrivateNotes_AcceptButton: 'ConfirmPage/RequestPrivateNotes/AcceptButton',
    SignData_RejectButton: 'ConfirmPage/SignData/RejectButton',
    SignData_AcceptButton: 'ConfirmPage/SignData/AcceptButton',
    RequestAssets_RejectButton: 'ConfirmPage/RequestAssets/RejectButton',
    RequestAssets_AcceptButton: 'ConfirmPage/RequestAssets/AcceptButton',
    RequestImportPrivateNote_RejectButton: 'ConfirmPage/RequestImportPrivateNote/RejectButton',
    RequestImportPrivateNote_AcceptButton: 'ConfirmPage/RequestImportPrivateNote/AcceptButton',
    RequestConsumableNotes_RejectButton: 'ConfirmPage/RequestConsumableNotes/RejectButton',
    RequestConsumableNotes_AcceptButton: 'ConfirmPage/RequestConsumableNotes/AcceptButton'
  };

  it('maps every member to its exact stable selector string', () => {
    expect(ConfirmPageSelectors.ConnectAction_CancelButton).toBe('ConfirmPage/ConnectAction/CancelButton');
    expect(ConfirmPageSelectors.ConnectAction_RetryButton).toBe('ConfirmPage/ConnectAction/RetryButton');
    expect(ConfirmPageSelectors.ConnectAction_ConnectButton).toBe('ConfirmPage/ConnectAction/ConnectButton');
    expect(ConfirmPageSelectors.SignAction_RejectButton).toBe('ConfirmPage/SignAction/RejectButton');
    expect(ConfirmPageSelectors.SignAction_SignButton).toBe('ConfirmPage/SignAction/SignButton');
    expect(ConfirmPageSelectors.DecryptAction_RejectButton).toBe('ConfirmPage/DecryptAction/RejectButton');
    expect(ConfirmPageSelectors.DecryptAction_AcceptButton).toBe('ConfirmPage/DecryptAction/AcceptButton');
    expect(ConfirmPageSelectors.RecordsAction_RejectButton).toBe('ConfirmPage/RecordsAction/RejectButton');
    expect(ConfirmPageSelectors.RecordsAction_AcceptButton).toBe('ConfirmPage/RecordsAction/AcceptButton');
    expect(ConfirmPageSelectors.TransactionAction_RejectButton).toBe('ConfirmPage/TransactionAction/RejectButton');
    expect(ConfirmPageSelectors.TransactionAction_AcceptButton).toBe('ConfirmPage/TransactionAction/AcceptButton');
    expect(ConfirmPageSelectors.ConsumeAction_RejectButton).toBe('ConfirmPage/ConsumeAction/RejectButton');
    expect(ConfirmPageSelectors.ConsumeAction_AcceptButton).toBe('ConfirmPage/ConsumeAction/AcceptButton');
    expect(ConfirmPageSelectors.BulkTransactionsAction_RejectButton).toBe(
      'ConfirmPage/BulkTransactionsAction/RejectButton'
    );
    expect(ConfirmPageSelectors.BulkTransactionsAction_AcceptButton).toBe(
      'ConfirmPage/BulkTransactionsAction/AcceptButton'
    );
    expect(ConfirmPageSelectors.DeployAction_RejectButton).toBe('ConfirmPage/DeployAction/RejectButton');
    expect(ConfirmPageSelectors.DeployAction_AcceptButton).toBe('ConfirmPage/DeployAction/AcceptButton');
    expect(ConfirmPageSelectors.RequestPrivateNotes_RejectButton).toBe('ConfirmPage/RequestPrivateNotes/RejectButton');
    expect(ConfirmPageSelectors.RequestPrivateNotes_AcceptButton).toBe('ConfirmPage/RequestPrivateNotes/AcceptButton');
    expect(ConfirmPageSelectors.SignData_RejectButton).toBe('ConfirmPage/SignData/RejectButton');
    expect(ConfirmPageSelectors.SignData_AcceptButton).toBe('ConfirmPage/SignData/AcceptButton');
    expect(ConfirmPageSelectors.RequestAssets_RejectButton).toBe('ConfirmPage/RequestAssets/RejectButton');
    expect(ConfirmPageSelectors.RequestAssets_AcceptButton).toBe('ConfirmPage/RequestAssets/AcceptButton');
    expect(ConfirmPageSelectors.RequestImportPrivateNote_RejectButton).toBe(
      'ConfirmPage/RequestImportPrivateNote/RejectButton'
    );
    expect(ConfirmPageSelectors.RequestImportPrivateNote_AcceptButton).toBe(
      'ConfirmPage/RequestImportPrivateNote/AcceptButton'
    );
    expect(ConfirmPageSelectors.RequestConsumableNotes_RejectButton).toBe(
      'ConfirmPage/RequestConsumableNotes/RejectButton'
    );
    expect(ConfirmPageSelectors.RequestConsumableNotes_AcceptButton).toBe(
      'ConfirmPage/RequestConsumableNotes/AcceptButton'
    );
  });

  it('exposes exactly the expected members in declaration order', () => {
    expect(Object.keys(ConfirmPageSelectors)).toEqual(Object.keys(EXPECTED));
    expect(Object.values(ConfirmPageSelectors)).toEqual(Object.values(EXPECTED));
  });

  it('matches the full expected key -> value mapping', () => {
    expect({ ...(ConfirmPageSelectors as Record<string, string>) }).toEqual(EXPECTED);
  });

  it('declares exactly 27 members', () => {
    expect(Object.keys(ConfirmPageSelectors)).toHaveLength(27);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(ConfirmPageSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    for (const value of Object.values(EXPECTED)) {
      expect((ConfirmPageSelectors as Record<string, string>)[value]).toBeUndefined();
    }
  });

  it('namespaces every value under the "ConfirmPage/" prefix and yields strings', () => {
    for (const value of Object.values(ConfirmPageSelectors)) {
      expect(typeof value).toBe('string');
      expect((value as string).startsWith('ConfirmPage/')).toBe(true);
    }
  });

  it('has unique selector values across all members', () => {
    const values = Object.values(ConfirmPageSelectors);
    expect(new Set(values).size).toBe(values.length);
  });

  it('pairs every non-connect action with matching Reject and Accept/Sign buttons', () => {
    // Each action group must expose complementary reject + accept style controls so
    // the confirm page can always render a decline and an approve control.
    const values = new Set<string>(Object.values(ConfirmPageSelectors));
    const rejectValues = [...values].filter(value => value.endsWith('/RejectButton'));
    for (const rejectValue of rejectValues) {
      const prefix = rejectValue.slice(0, -'RejectButton'.length);
      const hasApprove = values.has(`${prefix}AcceptButton`) || values.has(`${prefix}SignButton`);
      expect(hasApprove).toBe(true);
    }
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(ConfirmPageSelectors.TransactionAction_AcceptButton).toBe(
      ConfirmPageSelectors.TransactionAction_AcceptButton
    );
  });
});
