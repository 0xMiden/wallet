import { SendFormSelectors } from './SendForm.selectors';

// SendForm.selectors is a pure, dependency-free TypeScript string enum used to tag
// the send-flow UI controls (toggles, list items, inputs and action buttons) with
// stable automation/testIDs. A string enum has no reverse mapping, so the compiled
// object is exactly the set of named string members. We exercise every exported
// member end-to-end: its value, the shape of the compiled enum object, and the
// string-enum invariants (no numeric reverse-mapping keys). This covers every line
// the enum emits.
//
// Note: two distinct members deliberately share the same selector string
// (`AssetDropDown` and `AssetName` both map to 'Send Form/Asset Drop-down'), so the
// value set is intentionally NOT fully unique — the tests below assert that exact,
// intended aliasing rather than assuming one-value-per-key.

describe('SendFormSelectors', () => {
  // Verbatim expected mapping — one entry per source member (all 12), in
  // declaration order.
  const EXPECTED: Record<string, string> = {
    ToggleVisibilityButton: 'Send Form/Toggle Visibility Button',
    AssetItemButton: 'Send Form/Asset Item Button',
    ContactItemButton: 'Send Form/Contact Item Button',
    AssetDropDown: 'Send Form/Asset Drop-down',
    AssetName: 'Send Form/Asset Drop-down',
    AmountInput: 'Send Form/Amount Input',
    RecipientInput: 'Send Form/Recipient Input',
    SendButton: 'Send Form/Send Button',
    CancelSendButton: 'Send Form/Cancel Send Button',
    ConfirmButton: 'Send Form/Confirm Button',
    CancelConfirmButton: 'Send Form/Cancel Confirm Button',
    InitiatedHomeButton: 'Send Form/Initiated Home Button'
  };

  it('maps every member to its exact stable selector string', () => {
    expect(SendFormSelectors.ToggleVisibilityButton).toBe('Send Form/Toggle Visibility Button');
    expect(SendFormSelectors.AssetItemButton).toBe('Send Form/Asset Item Button');
    expect(SendFormSelectors.ContactItemButton).toBe('Send Form/Contact Item Button');
    expect(SendFormSelectors.AssetDropDown).toBe('Send Form/Asset Drop-down');
    expect(SendFormSelectors.AssetName).toBe('Send Form/Asset Drop-down');
    expect(SendFormSelectors.AmountInput).toBe('Send Form/Amount Input');
    expect(SendFormSelectors.RecipientInput).toBe('Send Form/Recipient Input');
    expect(SendFormSelectors.SendButton).toBe('Send Form/Send Button');
    expect(SendFormSelectors.CancelSendButton).toBe('Send Form/Cancel Send Button');
    expect(SendFormSelectors.ConfirmButton).toBe('Send Form/Confirm Button');
    expect(SendFormSelectors.CancelConfirmButton).toBe('Send Form/Cancel Confirm Button');
    expect(SendFormSelectors.InitiatedHomeButton).toBe('Send Form/Initiated Home Button');
  });

  it('exposes exactly the expected members in declaration order', () => {
    expect(Object.keys(SendFormSelectors)).toEqual(Object.keys(EXPECTED));
    expect(Object.values(SendFormSelectors)).toEqual(Object.values(EXPECTED));
  });

  it('matches the full expected key -> value mapping', () => {
    expect({ ...(SendFormSelectors as Record<string, string>) }).toEqual(EXPECTED);
  });

  it('exposes exactly twelve members', () => {
    expect(Object.keys(SendFormSelectors)).toHaveLength(12);
  });

  it('is a string enum without a numeric reverse mapping', () => {
    // String enums (unlike numeric ones) do not generate reverse `value -> key`
    // entries, so no numeric keys and no lookup by value should exist.
    const keys = Object.keys(SendFormSelectors);
    expect(keys.every(key => Number.isNaN(Number(key)))).toBe(true);
    for (const value of Object.values(EXPECTED)) {
      expect((SendFormSelectors as Record<string, string>)[value]).toBeUndefined();
    }
  });

  it('namespaces every value under the "Send Form/" prefix and yields strings', () => {
    for (const value of Object.values(SendFormSelectors)) {
      expect(typeof value).toBe('string');
      expect((value as string).startsWith('Send Form/')).toBe(true);
    }
  });

  it('aliases AssetDropDown and AssetName to the identical selector string', () => {
    // These two members intentionally share one value; the enum object still
    // carries both as distinct keys.
    expect(SendFormSelectors.AssetDropDown).toBe(SendFormSelectors.AssetName);
    expect(Object.keys(SendFormSelectors)).toEqual(expect.arrayContaining(['AssetDropDown', 'AssetName']));
  });

  it('has exactly one intentional duplicate among its selector values', () => {
    // 12 members, but AssetDropDown/AssetName share a value, so the distinct
    // value set has size 11.
    const values = Object.values(SendFormSelectors);
    expect(values).toHaveLength(12);
    expect(new Set(values).size).toBe(11);
  });

  it('is consistent across repeated accesses', () => {
    // Two reads of the same member must yield the identical string.
    expect(SendFormSelectors.SendButton).toBe(SendFormSelectors.SendButton);
    expect(SendFormSelectors.ConfirmButton).toBe(SendFormSelectors.ConfirmButton);
  });
});
