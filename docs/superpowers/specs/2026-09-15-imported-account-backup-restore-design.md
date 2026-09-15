# Imported Account Backup and Restore Design

## Decision

Issue #64 is resolved by completing the supported single-root path. Multiple mnemonic roots are not added. Private-key import and reveal are already implemented, so the remaining correctness defect is a focused backup and restore change: an encrypted wallet file must restore imported accounts and the exact auth secrets that control them.

The implementation PR closes #64 directly after the backup and restore path is verified end to end.

## Context

An imported account has `hdIndex: -1`. Its auth secret is not derivable from the wallet mnemonic. The current exporter therefore removes every imported account from `DecryptedWalletFile.accounts` and records only `omittedImportedAccountCount`. The restored Miden database can still contain the account, but `Vault.spawnFromMidenClient` skips it because no matching `WalletAccount` and no recoverable secret exist.

The encrypted file already contains sensitive wallet material under a file-password-derived key. Imported secrets belong inside that encrypted payload, never beside it or inside the unencrypted envelope.

## Goals

- Restore every imported single-signature account included in a new encrypted wallet file.
- Restore the exact auth secret and auth scheme without deriving anything from the mnemonic.
- Validate every secret-to-account binding before making the restored wallet usable.
- Preserve compatibility with older encrypted files that omit imported accounts.
- Fail the entire restore clearly if any declared imported account is missing, duplicated, malformed, or bound to the wrong secret.
- Keep multiple mnemonic roots out of scope.

## Non-goals

- Exporting device-bound Guardian hot keys.
- Adding mnemonic or wallet-specific import concepts to `miden-client`.
- Defining a public, unencrypted interchange format for auth secrets.
- Recovering imported accounts from old files that never contained their secrets.
- Partially restoring a new-format file after imported-account validation fails.

## Considered Approaches

### Selected: versioned encrypted payload with imported account secrets

Extend the decrypted payload with a version and a collection that binds each imported account to its auth secret. Restore validates the entire collection, inserts the secrets through the existing SDK keystore path, and only then publishes the new vault.

This preserves the current encrypted-file model, makes the backup self-contained, and does not expose wallet concepts to the CLI.

### Rejected: rely on the exported Miden database

The database can carry account state, but it is not a supported source for the wallet's encrypted vault secret. Treating internal IndexedDB content as an auth-secret interchange contract would couple recovery to an unstable implementation detail.

### Rejected: require users to export private keys separately

This keeps the current omission and leaves a file labeled as a wallet backup unable to restore all owned accounts. A warning does not make an incomplete backup correct.

## Payload Contract

`DecryptedWalletFile` gains:

```ts
type ImportedAccountBackup = {
  accountId: string;
  publicKeyCommitment: string;
  authScheme: AccountAuthScheme;
  secretKeyHex: string;
};

type DecryptedWalletFile = {
  formatVersion?: number;
  seedPhrase: string;
  midenClientDbContent: string;
  walletDbContent: string;
  accounts: WalletAccount[];
  importedAccounts?: ImportedAccountBackup[];
  omittedImportedAccountCount?: number;
};
```

`formatVersion` remains optional so files produced before this change parse as the legacy format. New exports write version 2. Version 2 files include all wallet account records and exactly one `ImportedAccountBackup` for every record with `hdIndex < 0`. New files omit the legacy `omittedImportedAccountCount` field.

The encrypted outer envelope does not change. The new secrets remain covered by the existing authenticated encryption.

## Export Flow

1. The existing wallet-password or hardware confirmation remains the single authorization gate for the backup.
2. The backend obtains the mnemonic and imported-account auth secrets from one unlocked vault instance. The UI does not issue one independent password derivation or biometric prompt per account.
3. For each imported account, the backend loads the current SDK account, resolves its single public-key commitment, reads the matching secret from the vault, and records the declared auth scheme.
4. The backend validates that every imported account has exactly one commitment and one secret before returning backup material.
5. The exporter includes all `WalletAccount` records and the complete imported-secret collection in the encrypted payload.
6. If any imported secret cannot be read or validated, export fails. It must not silently produce a partial backup or fall back to the legacy omission behavior.

The backend should expose one purpose-specific request for backup material rather than reusing the user-facing reveal-private-key request repeatedly. That keeps authorization atomic and avoids sending secrets through multiple independently authenticated calls.

## Restore Flow

1. Decrypt and validate the payload before clearing or replacing the active wallet.
2. Legacy files follow the current behavior. If `omittedImportedAccountCount` is positive, the existing omission notice remains.
3. A version 2 payload must contain a one-to-one mapping between every `WalletAccount` with `hdIndex < 0` and every imported backup entry. Reject missing entries, extras, duplicate account IDs, duplicate commitments, and duplicate secrets bound to more than one account.
4. Deserialize each secret with `AuthSecretKey.deserialize` and require its detected auth scheme to equal both the backup entry and the matching `WalletAccount.authScheme`.
5. Load the restored account from the imported Miden database. Resolve its public-key commitment and require it to equal the entry's normalized commitment.
6. Extract the deterministic account reconstruction from `Vault.importAccountFromPrivateKey` into a shared internal helper. Use that exact helper during restore and require its account ID to equal the restored account ID. This proves the secret belongs to the account rather than trusting strings in the file and prevents import and restore rules from drifting apart.
7. Insert the validated secret through `midenClient.client.keystore.insert(account.id(), secretKey)` while the restore holds the existing WASM client lock and its ownership checks.
8. Persist all account records under the new vault key only after the complete imported collection validates and all keystore inserts succeed.
9. Set the current account only after a non-empty, fully validated account collection is ready.

The restore remains atomic from the application's perspective. A failure rejects the spawn and leaves no unlocked partial wallet available to the UI.

## Security Invariants

- Imported secrets occur only inside the authenticated encrypted payload and transient in-memory values.
- Logs, analytics, exceptions, and filenames never contain secret bytes.
- Export fails closed if any owned imported account cannot be included.
- Restore never derives an imported secret from the mnemonic.
- Restore never inserts a secret until its scheme, commitment, and account ID all match.
- Version 2 restore never silently drops an imported account.
- Guardian hot secrets remain excluded because they are device-bound and have a separate recovery model.
- Existing password attempt limits, hardware authorization, and export confirmation remain in force.

## Error Handling

Export reports one actionable message when an imported account cannot be backed up: the file was not created and the named account must be repaired or removed before retrying. The message identifies the account by user-visible name, never by secret or full internal metadata.

Restore distinguishes unsupported format version, malformed imported-account data, missing secret, secret/account mismatch, and SDK insertion failure. Technical details may be logged only after the normal logger redaction path. The user-facing result is a failed restore, not a partially available wallet.

## Compatibility

- Legacy files with no `formatVersion` continue to restore exactly as they do now.
- Legacy files with `omittedImportedAccountCount` continue to warn that imported accounts were not included.
- New readers reject unknown future major versions.
- New files are not promised to older wallet versions. The import screen should report an unsupported newer backup rather than a generic decryption failure.

## Testing

### Unit tests

- A version 2 export includes all HD and imported account records plus one validated secret entry per imported account.
- Export fails before file creation when one imported secret is missing or its account has an unsupported auth shape.
- Hardware-backed export authorizes once for multiple imported accounts.
- Legacy export behavior is not used for new files.
- Version 2 restore accepts valid Falcon and ECDSA imported accounts.
- Restore rejects missing, extra, duplicate, malformed, wrong-scheme, wrong-commitment, and wrong-account-ID entries.
- Restore inserts each secret under the matching account through the SDK keystore path.
- Any validation or insertion failure leaves no usable partial vault state.
- Legacy files without imported secrets retain the current warning and restore behavior.
- Unknown future versions fail with the dedicated unsupported-version error.

### Integration test

Create a wallet with one HD account and imported Falcon and ECDSA accounts, fund or otherwise identify each account, export through the real encrypted-file path, clear isolated storage, restore with a new wallet password, and prove that every account is visible and can sign a transaction or signature challenge with the same account ID.

### Regression proof

The new test must first fail against current main because `ExportFileComplete` filters `hdIndex < 0` accounts and the restored vault has no imported secrets. The same test passes after the implementation without weakening any existing encrypted-file tests.

## Delivery

The PR covers only imported-account backup correctness and contains a standalone `Closes #64`. Multiple mnemonic roots remain explicitly out of scope.
