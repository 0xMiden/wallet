# Onboarding Feature Documentation

## Overview

The onboarding feature guides the user through setting up their wallet in the application. This includes creating a new wallet or importing an existing one. The flow is divided into two main paths: creating a wallet and importing a wallet.

## Directory Structure

- **common**: Contains components that are shared across different flows such as creating a password and the confirmation screen.
- **createWalletFlow**: Contains components specific to the process of creating a new wallet.
- **importWalletFlow**: Contains components specific to the process of importing an existing wallet.

## Screen Flow

### Welcome Screen

- **Path**: [`common/Welcome.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/common/Welcome.tsx)
- **Description**: The entry point of the onboarding process. The user is greeted and given the choice to either create a new wallet or import an existing one.

### Create Wallet Flow

- **Back Up Your Wallet**
  - **Path**: [`create-wallet-flow/BackUpSeedPhrase.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/create-wallet-flow/BackUpSeedPhrase.tsx)
  - **Description**: Guides the user through backing up their new wallet by noting down the seed phrase.
- **Verify Seed Phrase**
  - **Path**: [`create-wallet-flow/VerifySeedPhrase.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/create-wallet-flow/VerifySeedPhrase.tsx)
  - **Description**: Ensures the user correctly noted the seed phrase by asking them to input it.
- **Create Password**
  - **Path**: [`common/CreatePassword.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/common/CreatePassword.tsx)
  - **Description**: Allows the user to set a password for their wallet, adding an extra layer of security.
- **Select Transaction Type**
  - **Path**: [`create-wallet-flow/SelectTransactionType.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/create-wallet-flow/SelectTransactionType.tsx)
  - **Description**: Lets the user choose the transaction type they prefer.
- **Confirmation**
  - **Path**: [`common/Confirmation.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/common/Confirmation.tsx)
  - **Description**: A final confirmation screen summarizing the wallet setup.

### Import Wallet Flow

- **Import Wallet (Seed Phrase)**
  - **Path**: [`import-wallet-flow/ImportSeedPhrase.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/import-wallet-flow/ImportSeedPhrase.tsx)
  - **Description**: Allows the user to input their existing seed phrase to import their wallet.
- **Create Password**
  - **Path**: [`common/CreatePassword.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/common/CreatePassword.tsx)
  - **Description**: Similar to the create wallet flow, this step involves creating a password for the imported wallet.
- **Confirmation**
  - **Path**: [`common/Confirmation.tsx`](https://github.com/S0nee/miden-wallet/blob/README/src/screens/onboarding/common/Confirmation.tsx)
  - **Description**: Confirms that the wallet has been successfully imported.
