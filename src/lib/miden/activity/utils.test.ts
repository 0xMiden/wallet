import { compareAccountIds } from './utils';
import { sameWalletAccountId } from '../sdk/helpers';

jest.mock('../sdk/helpers', () => ({
  sameWalletAccountId: jest.fn((a: string, b: string) => {
    const canonical = (id: string) => {
      const address = id.split('_')[0] ?? id;
      return address === '0x817edea77acc5d71616e493afecea3' || address === 'mtst1azqhah480tx96utpdeyn4lkw5v5fsdmw'
        ? 'canonical-account-id'
        : address;
    };
    return canonical(a) === canonical(b);
  })
}));

describe('compareAccountIds', () => {
  beforeEach(() => {
    jest.mocked(sameWalletAccountId).mockClear();
  });

  it('matches a valid hex ID with its equivalent bech32 form through canonical account comparison', () => {
    // The production behavior that makes this pass is compareAccountIds delegating to sameWalletAccountId.
    expect(
      compareAccountIds('0x817edea77acc5d71616e493afecea3', 'mtst1azqhah480tx96utpdeyn4lkw5v5fsdmw_qr7qqq9wr6w')
    ).toBe(true);
    expect(sameWalletAccountId).toHaveBeenCalledTimes(1);
  });

  it('skips sameWalletAccountId when stripped prefixes match non-empty bases', () => {
    expect(compareAccountIds('acc1_tag1', 'acc1_tag2')).toBe(true);
    expect(compareAccountIds('acc1', 'acc1_tag')).toBe(true);
    expect(
      compareAccountIds('mtst1azqhah480tx96utpdeyn4lkw5v5fsdmw', 'mtst1azqhah480tx96utpdeyn4lkw5v5fsdmw_qr7qqq9wr6w')
    ).toBe(true);
    expect(compareAccountIds('0x817edea77acc5d71616e493afecea3', '0x817edea77acc5d71616e493afecea3')).toBe(true);
    expect(sameWalletAccountId).not.toHaveBeenCalled();
  });

  it('refuses empty base prefixes before the underscore', () => {
    expect(compareAccountIds('_tag1', '_tag2')).toBe(false);
    expect(compareAccountIds('_tag1', 'acc1')).toBe(false);
    expect(sameWalletAccountId).not.toHaveBeenCalled();
  });

  it('returns true for identical IDs without tags', () => {
    expect(compareAccountIds('acc1', 'acc1')).toBe(true);
  });

  it('returns true for identical IDs with matching tags', () => {
    expect(compareAccountIds('acc1_tag', 'acc1_tag')).toBe(true);
  });

  it('returns true for same base ID with different tags', () => {
    expect(compareAccountIds('acc1_tag1', 'acc1_tag2')).toBe(true);
  });

  it('returns true when one ID has tag and other does not', () => {
    expect(compareAccountIds('acc1', 'acc1_tag')).toBe(true);
    expect(compareAccountIds('acc1_tag', 'acc1')).toBe(true);
  });

  it('returns false for different base IDs', () => {
    expect(compareAccountIds('acc1', 'acc2')).toBe(false);
    expect(compareAccountIds('acc1_tag', 'acc2_tag')).toBe(false);
  });

  it('returns false when first ID is empty', () => {
    expect(compareAccountIds('', 'acc1')).toBe(false);
  });

  it('returns false when second ID is empty', () => {
    expect(compareAccountIds('acc1', '')).toBe(false);
  });

  it('returns false when both IDs are empty', () => {
    expect(compareAccountIds('', '')).toBe(false);
  });

  it('returns false when first ID is null or undefined', () => {
    expect(compareAccountIds(null as unknown as string, 'acc1')).toBe(false);
    expect(compareAccountIds(undefined as unknown as string, 'acc1')).toBe(false);
  });

  it('returns false when second ID is null or undefined', () => {
    expect(compareAccountIds('acc1', null as unknown as string)).toBe(false);
    expect(compareAccountIds('acc1', undefined as unknown as string)).toBe(false);
  });

  it('handles IDs with multiple underscores correctly', () => {
    expect(compareAccountIds('acc1_tag_extra', 'acc1_other')).toBe(true);
    expect(compareAccountIds('acc1_tag_extra', 'acc1')).toBe(true);
  });
});
