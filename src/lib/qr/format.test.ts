import { encodeAddress, decodeAddress, isValidMidenAddress } from './format';

describe('QR format utilities', () => {
  const testnetAddress = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
  // Real Miden mainnet prefix is `mm1` (not `m1`).
  const mainnetAddress = 'mm1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
  const devnetAddress = 'mdev1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
  const localnetAddress = 'mlcl1araq55u3a4tsqsfznep06x8t9q4cr0am_qr7qqq9wr6w';

  describe('encodeAddress', () => {
    it('adds miden: prefix to address', () => {
      expect(encodeAddress(testnetAddress)).toBe(`miden:${testnetAddress}`);
    });

    it('encodes mainnet address', () => {
      expect(encodeAddress(mainnetAddress)).toBe(`miden:${mainnetAddress}`);
    });

    it('handles empty string', () => {
      expect(encodeAddress('')).toBe('miden:');
    });
  });

  describe('decodeAddress', () => {
    it('strips miden: prefix', () => {
      expect(decodeAddress(`miden:${testnetAddress}`)).toBe(testnetAddress);
    });

    it('handles uppercase MIDEN: prefix', () => {
      expect(decodeAddress(`MIDEN:${testnetAddress}`)).toBe(testnetAddress);
    });

    it('handles mixed case Miden: prefix', () => {
      expect(decodeAddress(`Miden:${testnetAddress}`)).toBe(testnetAddress);
    });

    it('returns plain address unchanged', () => {
      expect(decodeAddress(testnetAddress)).toBe(testnetAddress);
    });

    it('trims whitespace', () => {
      expect(decodeAddress(`  ${testnetAddress}  `)).toBe(testnetAddress);
    });

    it('trims whitespace with prefix', () => {
      expect(decodeAddress(`  miden:${testnetAddress}  `)).toBe(testnetAddress);
    });
  });

  describe('isValidMidenAddress', () => {
    it('validates testnet address', () => {
      expect(isValidMidenAddress(testnetAddress)).toBe(true);
    });

    it('validates mainnet address', () => {
      expect(isValidMidenAddress(mainnetAddress)).toBe(true);
    });

    it('validates devnet address', () => {
      expect(isValidMidenAddress(devnetAddress)).toBe(true);
    });

    // Regression: a localnet (`mlcl1`) address scanned via QR under a
    // dev-settings localhost override was previously rejected as invalid,
    // because this validator hard-coded only `mtst1`/`m1`.
    it('validates localnet address (dev-settings localhost override)', () => {
      expect(isValidMidenAddress(localnetAddress)).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isValidMidenAddress('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidMidenAddress(null as unknown as string)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidMidenAddress(undefined as unknown as string)).toBe(false);
    });

    it('rejects non-string', () => {
      expect(isValidMidenAddress(123 as unknown as string)).toBe(false);
    });

    it('rejects address without valid prefix', () => {
      expect(isValidMidenAddress('eth1abc123def456')).toBe(false);
    });

    it('rejects address that is too short', () => {
      expect(isValidMidenAddress('mtst1abc')).toBe(false);
    });

    it('rejects address that is too long', () => {
      const longAddress = 'mtst1' + 'a'.repeat(100);
      expect(isValidMidenAddress(longAddress)).toBe(false);
    });

    it('trims whitespace before validating', () => {
      expect(isValidMidenAddress(`  ${testnetAddress}  `)).toBe(true);
    });

    it('validates address at minimum length boundary', () => {
      // 30 characters minimum
      const minAddress = 'mtst1' + 'a'.repeat(25);
      expect(isValidMidenAddress(minAddress)).toBe(true);
    });

    it('validates address at maximum length boundary', () => {
      // 100 characters maximum
      const maxAddress = 'mtst1' + 'a'.repeat(95);
      expect(isValidMidenAddress(maxAddress)).toBe(true);
    });
  });
});
