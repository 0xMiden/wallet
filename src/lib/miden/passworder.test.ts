import { Buffer } from 'buffer';

import {
  decrypt,
  decryptJson,
  decryptVaultKeyWithPassword,
  deriveKey,
  deriveKeyLegacy,
  encrypt,
  encryptJson,
  encryptVaultKeyWithPassword,
  exportKey,
  generateKey,
  generateKeyFromHash,
  generateKeyHash,
  generateKeyLegacy,
  generateSalt,
  generateVaultKey,
  importVaultKey,
  verifyPassword
} from './passworder';

describe('passworder', () => {
  describe('generateSalt', () => {
    it('returns a 32-byte Uint8Array by default', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(salt.byteLength).toBe(32);
    });

    it('respects the byteCount argument', () => {
      expect(generateSalt(16).byteLength).toBe(16);
      expect(generateSalt(64).byteLength).toBe(64);
    });

    it('returns different values each call', () => {
      const a = generateSalt();
      const b = generateSalt();
      // Astronomically unlikely to collide
      expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    });
  });

  describe('generateKey', () => {
    it('is deterministic for a given password', async () => {
      const k1 = await generateKey('hunter2');
      const k2 = await generateKey('hunter2');
      // Both keys should successfully derive the same AES key
      const salt = generateSalt();
      const d1 = await deriveKey(k1, salt);
      const d2 = await deriveKey(k2, salt, 1_310_000);
      const iv = new Uint8Array(16);
      const p1 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, d1, Buffer.from('abc'));
      const p2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, d2, Buffer.from('abc'));
      expect(Buffer.from(p1).toString('hex')).toBe(Buffer.from(p2).toString('hex'));
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips JSON-serialisable data', async () => {
      const passKey = await generateKey('correct horse battery staple');
      const derived = await deriveKey(passKey, generateSalt(), 1000);
      const payload = { foo: 'bar', nested: { x: [1, 2, 3] } };
      const enc = await encrypt(payload, derived);
      expect(typeof enc.dt).toBe('string');
      expect(typeof enc.iv).toBe('string');
      const dec = await decrypt<typeof payload>(enc, derived);
      expect(dec).toEqual(payload);
    });

    it('fails when the key is wrong', async () => {
      const good = await deriveKey(await generateKey('pw1'), generateSalt(), 1000);
      const bad = await deriveKey(await generateKey('pw2'), generateSalt(), 1000);
      const enc = await encrypt({ secret: 42 }, good);
      await expect(decrypt(enc, bad)).rejects.toBeTruthy();
    });
  });

  describe('encryptJson / decryptJson', () => {
    it('round-trips data via base64 encoding', async () => {
      const derived = await deriveKey(await generateKey('pw'), generateSalt(), 1000);
      const payload = { hello: 'world', arr: [1, 2, 3, { nested: true }] };
      const enc = await encryptJson(payload, derived);
      // base64 chars only
      expect(enc.dt).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
      const dec = await decryptJson(enc, derived);
      expect(dec).toEqual(payload);
    });

    it('throws with a helpful message when decrypted payload is not JSON', async () => {
      const derived = await deriveKey(await generateKey('pw'), generateSalt(), 1000);
      // Encrypt raw non-JSON bytes directly, then feed through decryptJson
      const iv = crypto.getRandomValues(new Uint8Array(16));
      const garbage = new TextEncoder().encode('not-json');
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derived, garbage);
      const toB64 = (buf: ArrayBuffer | Uint8Array) =>
        Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64');
      await expect(decryptJson({ dt: toB64(ciphertext), iv: toB64(iv) }, derived)).rejects.toThrow(
        /JSON parsing failed/
      );
    });

    it('throws when key is wrong', async () => {
      const good = await deriveKey(await generateKey('a'), generateSalt(), 1000);
      const bad = await deriveKey(await generateKey('b'), generateSalt(), 1000);
      const enc = await encryptJson({ x: 1 }, good);
      await expect(decryptJson(enc, bad)).rejects.toBeTruthy();
    });
  });

  describe('legacy helpers', () => {
    it('generateKeyLegacy + deriveKeyLegacy still produce a usable key', async () => {
      const passKey = await generateKeyLegacy('legacy-pw');
      const derived = await deriveKeyLegacy(passKey, generateSalt());
      const payload = { legacy: true };
      const enc = await encrypt(payload, derived);
      const dec = await decrypt(enc, derived);
      expect(dec).toEqual(payload);
    });
  });

  describe('generateKeyHash / generateKeyFromHash', () => {
    it('produces a stable base64 hash for the same password', async () => {
      const h1 = await generateKeyHash('same-password');
      const h2 = await generateKeyHash('same-password');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('produces different hashes for different passwords', async () => {
      expect(await generateKeyHash('a')).not.toBe(await generateKeyHash('b'));
    });

    it('generateKeyFromHash round-trips encryption with generateKey-derived key', async () => {
      const password = 'pw-round-trip';
      const hash = await generateKeyHash(password);
      const fromHash = await generateKeyFromHash(hash);
      const fromPassword = await generateKey(password);

      const salt = generateSalt();
      const d1 = await deriveKey(fromHash, salt);
      const d2 = await deriveKey(fromPassword, salt);
      const enc = await encrypt({ value: 1 }, d1);
      const dec = await decrypt(enc, d2);
      expect(dec).toEqual({ value: 1 });
    });
  });

  describe('vault key model', () => {
    it('generateVaultKey returns a 32-byte random key', () => {
      const k1 = generateVaultKey();
      const k2 = generateVaultKey();
      expect(k1.byteLength).toBe(32);
      expect(k2.byteLength).toBe(32);
      expect(Buffer.from(k1).toString('hex')).not.toBe(Buffer.from(k2).toString('hex'));
    });

    it('importVaultKey returns a CryptoKey usable for AES-GCM encrypt/decrypt', async () => {
      const raw = generateVaultKey();
      const cryptoKey = await importVaultKey(raw);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode('hello vault');
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
      expect(new TextDecoder().decode(pt)).toBe('hello vault');
    });

    it('exportKey returns raw bytes for an extractable key', async () => {
      // Build an explicitly-extractable AES-GCM key so exportKey works
      const raw = generateVaultKey();
      const buffer = new ArrayBuffer(raw.byteLength);
      new Uint8Array(buffer).set(raw);
      const extractableKey = await crypto.subtle.importKey('raw', buffer, { name: 'AES-GCM' }, true, [
        'encrypt',
        'decrypt'
      ]);
      const exported = await exportKey(extractableKey);
      expect(Buffer.from(exported).toString('hex')).toBe(Buffer.from(raw).toString('hex'));
    });

    it('encryptVaultKeyWithPassword + decryptVaultKeyWithPassword round-trips', async () => {
      const vaultKey = generateVaultKey();
      const password = 'super-secret';
      const encrypted = await encryptVaultKeyWithPassword(vaultKey, password);
      expect(typeof encrypted).toBe('string');
      expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
      const decrypted = await decryptVaultKeyWithPassword(encrypted, password);
      expect(Buffer.from(decrypted).toString('hex')).toBe(Buffer.from(vaultKey).toString('hex'));
    });

    it('decryptVaultKeyWithPassword fails on wrong password', async () => {
      const encrypted = await encryptVaultKeyWithPassword(generateVaultKey(), 'right');
      await expect(decryptVaultKeyWithPassword(encrypted, 'wrong')).rejects.toBeTruthy();
    });

    it('verifyPassword returns true for the correct password', async () => {
      const encrypted = await encryptVaultKeyWithPassword(generateVaultKey(), 'correct');
      expect(await verifyPassword(encrypted, 'correct')).toBe(true);
    });

    it('verifyPassword returns false for the wrong password', async () => {
      const encrypted = await encryptVaultKeyWithPassword(generateVaultKey(), 'correct');
      expect(await verifyPassword(encrypted, 'wrong')).toBe(false);
    });

    it('verifyPassword returns false on malformed input', async () => {
      expect(await verifyPassword('!!not-base64!!', 'anything')).toBe(false);
    });
  });
});
