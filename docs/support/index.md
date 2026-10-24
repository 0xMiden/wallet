---
title: Support - Bread Wallet by Miden
permalink: /support/
---

# Bread Wallet by Miden - Support

Need help with Bread Wallet? We're here to help. Below are the ways to reach us and answers to common questions.

## Contact us

- **Email:** [privacy@miden.team](mailto:privacy@miden.team) - for any question, problem, or help request. We aim to respond within a few business days.
- **Report a bug or request a feature:** open an issue at [github.com/0xMiden/wallet/issues](https://github.com/0xMiden/wallet/issues).
- **Send feedback:** use our [feedback form](https://cmuv78o9w003x5ebpyha3cf6p.zapier.app/page).

When you contact us, please include your device model, OS version, and app version (Settings → About), plus a description of the problem - it helps us help you faster. Never share your recovery phrase or private keys with anyone, including us.

## Frequently asked questions

### I'm locked out or lost my recovery phrase - can you recover my wallet?
Bread Wallet is a **non-custodial** wallet: your recovery phrase and account keys are generated or imported into local storage, and we never have access to them. You can restore supported account state from a password-encrypted Encrypted Wallet File; depending on your accounts, it can include the recovery phrase or imported signing secrets. We cannot reset your credentials or recover funds on your behalf. Please keep your recovery phrase and any wallet files safe and private.

### How do I unlock the app with Face ID or Touch ID?
Enable biometric unlock in **Settings**. Face ID / Touch ID is handled entirely by your device's operating system - the app never receives your face or fingerprint data, only a success/failure result. See our [Privacy Policy](https://0xmiden.github.io/wallet/privacy/) for details.

### The app isn't syncing, or a transaction seems stuck.
First, check your internet connection and reopen the app to let it re-sync. If a transaction stays pending, give the network a few minutes. If the problem persists, email us at [privacy@miden.team](mailto:privacy@miden.team) with your app version and a description, and we'll investigate.

### Is my wallet data private?
Your recovery phrase and account keys are kept in local storage, and the App does not send them to Miden. Guardian operators receive encrypted account state for the Guardian accounts they protect. If you export an Encrypted Wallet File, it is encrypted with the password you choose and saved where you direct it; it may contain the recovery phrase if stored and signing secrets for eligible imported accounts. Anyone with the file and its password can read its contents. See the [Privacy Policy](https://0xmiden.github.io/wallet/privacy/).

### How do I back up or move my wallet to a new device?
Keep your recovery phrase safe and import it on the new device: it restores a seed-derived Guardian account while your Guardian Operator can return its account state. A current **Encrypted Wallet File** is a password-encrypted snapshot of account state for accounts it can restore. It includes your recovery phrase only if one is stored in the wallet. A wallet with no stored phrase can still save a file for eligible imported accounts if none depends on a phrase-derived key; that file includes the signing secrets needed to restore those accounts. A Guardian account imported from an Everyday Key alone is not included, and a Guardian account's Everyday Key is never in the file. For a seed-derived Guardian account, the file restores its state and phrase without the operator; then replace its Everyday Key with the operator's ACK or use your saved key pair (**Settings → Keys → Reveal Private Key**). The file is a snapshot of the moment you saved it, so save a new one after you send or receive. Anyone with the file and its password can read its contents. Never store your recovery phrase in plain text where others could access it.

### Can I remove the recovery phrase from this device?

Open **Settings → Security → Recovery Phrase → Remove recovery phrase**. Write the words on paper, complete the word check, and confirm removal. Keep the paper outside this device.

Daily transactions still use the stored signing keys. When you change the Guardian, replace the everyday key, or change a procedure threshold, enter your recovery phrase to continue. The wallet checks that it belongs to the account and uses the recovery key only for that action. It does not save the phrase again. If an action waits for the recovery phrase, open it in Activity and select **Enter your recovery phrase**.

Removal affects this local wallet. It does not delete backups that you previously made. Account creation without a stored recovery phrase is not yet supported. Wallet export changes are planned separately.

## More

- [Developer guide](https://0xmiden.github.io/wallet/developers/) for building dApps for Bread
- [Privacy Policy](https://0xmiden.github.io/wallet/privacy/)
