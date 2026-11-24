---
title: Terms of Service — Bread Wallet by Miden
permalink: /tos/
---

# Bread Wallet Terms of Service

_Version 2.0, effective 20 October 2026_

Please read these Terms carefully. They describe what Bread Wallet does, what we and the parties we work with are responsible for, and the risks of using software and networks that are still at an early stage. If you do not agree, do not use Bread Wallet.

## 1. Acceptance and parties

**1.1 Parties.** These Terms of Service ("Terms") are an agreement between you and Miden Technologies (US) Corp., a Delaware corporation (file number 10598340) with its registered address at 850 New Burton Road, Suite 201, Dover, Delaware 19904-5786, United States ("Miden", "we", "us"). They govern your access to and use of Bread Wallet, the software wallet for the Miden network, including its Guardian, Earn, swap, bridge and fiat on-ramp and off-ramp features (together, the "Services"). The Miden network itself is operated by the Miden Foundation, a foundation organised under the laws of the Republic of Panama (registration number 25068980) with its registered address at Via Ricardo J. Alfaro, Edificio PH The Century Tower, Oficina 317, Suite 742, Corregimiento Betania, Distrito Panamá, Provincia Panamá, Republic of Panama (the "Foundation"). The Foundation is a separate party from us. It operates the network's sequencer, one of the network's validators and the USDCx contract (section 8), itself or through a contractor acting on its behalf, currently Gateway.fm (GATEWAY.FM AS). Where these Terms refer to the network operator, they mean the Foundation. The Miden swap solver is operated by 0D Labs Limited (6.1), also a separate party from us.

**1.2 Incorporated documents.** By downloading, accessing or using Bread Wallet you agree to these Terms and to the following documents, each incorporated by reference: our Privacy Policy at [https://0xmiden.github.io/wallet/privacy/](https://0xmiden.github.io/wallet/privacy/) and the Miden Network Legal and Compliance Disclosures at [https://0xmiden.github.io/wallet/compliance/](https://0xmiden.github.io/wallet/compliance/), which contain the Sanctions Compliance Statement (Part I) and the Prohibited-User Disclosure (Part II). If you do not agree, do not use Bread Wallet.

**1.3 Third-party terms.** Some features are provided by third parties under their own terms (sections 4 to 8). Where a feature is provided by a third party, that party's terms govern your relationship with it, and we will identify the party and link its terms where the feature is offered in the app. You must comply with those terms when using the feature.

**1.4 Apple users.** If you obtained Bread Wallet through the Apple App Store, section 15.3 also applies.

**1.5 Scope.** These Terms cover your use of Bread Wallet and of the infrastructure it connects to when accessed through Bread Wallet: the Foundation's sequencer, and the services we host (the note transport service, any remote prover and the bridge interface). They do not govern independent use of open-source Miden software outside that infrastructure. Services accessed outside Bread Wallet are not covered by these Terms.

## 2. Eligibility and Prohibited Users

**2.1 Age and capacity.** You must be at least 18 years old and legally capable of entering into these Terms.

**2.2 Prohibited Users.** You may not use Bread Wallet if you are a Prohibited User as defined in the Sanctions Compliance Statement. This includes any person or entity subject to sanctions administered by OFAC, the European Union, the United Kingdom or the other programs listed in the Sanctions Compliance Statement, and any person located, organized or resident in a comprehensively sanctioned jurisdiction.

**2.3 Your representations.** On each use of Bread Wallet you represent and warrant that: (a) you are not a Prohibited User and are not acting on behalf of one; (b) you are not located in a country subject to a U.S. Government embargo or designated by the U.S. Government as a "terrorist supporting" country; (c) you are not listed on any U.S. Government list of prohibited or restricted parties; and (d) you are using Bread Wallet on your own account and not on behalf of another person, except as permitted in section 13.

**2.4 Feature availability.** Some features are not available in every region, and a feature available today may be withdrawn from your region (section 11). Third-party providers apply their own eligibility checks, including identity verification, before you can use their feature (sections 5 and 7).

## 3. Nature of the Wallet; your keys; account state; recovery

**3.1 Self-custodial software.** Bread Wallet is software that lets you create and operate accounts on the Miden network. Your assets exist on the network, not with us. We do not hold your assets, cannot move them, and cannot reverse a transaction you have authorized. Nothing in Bread Wallet constitutes custody of assets by Miden or any Guardian Operator, and no fiduciary relationship is created.

**3.2 Your keys.** Some accounts use keys derived from a Recovery Phrase; a Guardian account also uses a separate Everyday Key for ordinary transactions. The App stores these credentials on your device when they are present. You can copy the Recovery Phrase, and you can download it and remove it from your device so that it is held offline. Eligible imported public accounts instead use imported signing keys and may have no Recovery Phrase; the App stores those keys locally, and an Encrypted Wallet File may include them as described in 3.5. For a Guardian account, the Recovery Phrase does not restore the Everyday Key, and the Everyday Key cannot replace a lost Recovery Phrase. Your Recovery Phrase also derives the EVM key that Earn uses (section 5). You are solely responsible for safeguarding your Recovery Phrase, Everyday Key, imported signing keys and device credentials. We and your Guardian Operator never hold your keys, cannot access or reconstruct them, and cannot recover them if you lose them. For a Guardian account, if you lose both the Everyday Key and Recovery Phrase and have no usable Encrypted Wallet File, neither we nor any Guardian Operator can restore access to your assets.

**3.3 Account state.** A Miden private account's data (its "account state") is not stored on the public network. To transact from a private account you need a current copy of its account state in addition to your keys. Copies of your account state may be held: (a) on your device; (b) by your Guardian Operator, if you have enabled a Guardian (section 4); and (c) in an Encrypted Wallet File you save (3.5). An Encrypted Wallet File is a password-encrypted snapshot of account state for the accounts it can restore. It contains your Recovery Phrase if one is stored in your wallet, and it can contain signing secrets for eligible imported public accounts. It does not contain the Everyday Key for a Guardian account. Whoever holds the file and its password can read the account state and any phrase or imported-account secret it contains. The file is saved where you choose and is not sent to us or to any Guardian Operator. Keys and account state are different things. Losing your keys and losing your account state have different consequences, set out in 3.4.

**3.4 What recovery can and cannot do.** Guardian recovery restores account state, not keys. It works only in combination with a credential you still control. Replacing a lost Everyday Key requires your Recovery Phrase and your Guardian Operator's ACK. A lost Recovery Phrase cannot currently be replaced. If you lose it, move your assets to a new account while your Everyday Key still works.

| **Situation** | **Can you transact?** | **What recovery can do** |
|---|---|---|
| Lost or new device, Recovery Phrase saved, Guardian Operator available | Yes, after restore and rotation | You restore from your Recovery Phrase; your Guardian Operator returns your account state; you rotate in a new Everyday Key with your Recovery Phrase and your Guardian Operator's ACK |
| Lost or new device, Guardian Operator unavailable or its copy lost, current Encrypted Wallet File saved, Everyday Key saved as a key pair | Yes, after restore | You restore your account state and your Recovery Phrase from the Encrypted Wallet File and import your saved Everyday Key pair. Your Guardian Operator is not needed, and you can then rotate to another operator (4.5) |
| Lost or new device, Guardian Operator unavailable or its copy lost, current Encrypted Wallet File saved, Everyday Key not saved | No, until the Guardian Operator is available again | The file restores your account state and your Recovery Phrase. A new Everyday Key is rotated in with your Recovery Phrase and your Guardian Operator's ACK, so you wait for the operator |
| Lost or new device, Recovery Phrase saved, no current Encrypted Wallet File, Guardian Operator temporarily unavailable with its state copy intact | No, until the operator returns | The operator can return its copy when available. Your Recovery Phrase restores your keys, not account state |
| Lost or new device, Recovery Phrase saved, no current Encrypted Wallet File, Guardian Operator's state copy lost and no other current copy exists | No | No one can restore the missing account state. Your Recovery Phrase restores your keys, not account state |
| Lost Everyday Key, Recovery Phrase intact, device and state intact | Yes, after rotation | You rotate in a new Everyday Key using your Recovery Phrase. The rotation requires your Guardian Operator's ACK |
| Lost Recovery Phrase, Everyday Key intact | Yes, with the Everyday Key, for as long as it works | Nothing. A new Recovery Phrase cannot be set up with the Everyday Key. Move your assets to a new account while you still can |
| Lost both the Everyday Key and the Recovery Phrase for a Guardian account, with no usable Encrypted Wallet File | No | No one can replace either credential or restore access to that Guardian account |
| An eligible imported account's key is lost, but a current Encrypted Wallet File contains that account's state and signing secret | Yes, after restore | Restore that imported account from the file; it does not need a Recovery Phrase |
| Your Guardian Operator pauses you or is offline; both credentials and state on your device intact | Yes, after rotation | You rotate to another operator with your Everyday Key and Recovery Phrase. The old operator's cooperation is not needed |
| Your Guardian Operator pauses you or is offline; Recovery Phrase lost | No, until the pause ends or the operator returns | Nothing. Rotation needs both credentials |
| Everyday Key and Recovery Phrase intact, no current account state on your device, Guardian copy or a current Encrypted Wallet File available | Yes, after restore | Restore account state from your Guardian Operator or from your Encrypted Wallet File |
| Everyday Key and Recovery Phrase intact, no current account state anywhere | No, even though you hold your credentials | Nothing (section 4.7) |

**3.5 Your responsibility for backups.** You are responsible for keeping your Recovery Phrase safe. Bread Wallet lets you save an Encrypted Wallet File (Settings → Security → Encrypted Wallet File) with the current account state for accounts it supports. It includes your Recovery Phrase only if one is stored in your wallet. A wallet with no stored Recovery Phrase can still save a file for eligible imported accounts if none of its accounts depends on a phrase-derived key; the file contains the signing secret needed to restore each eligible imported public account. A Guardian account imported from an Everyday Key alone is not included, and the file does not contain the Everyday Key for a Guardian account. You can reveal that Guardian Everyday Key as a key pair (Settings → Keys → Reveal Private Key). For a Guardian account created from your Recovery Phrase, a current Encrypted Wallet File and a saved Everyday Key pair let you restore and rotate on a new device without your Guardian Operator. You are responsible for keeping both safe and for keeping the file current: it is a snapshot, and an older file cannot restore what happened after it was saved, so save a new one after you send or receive.

## 4. Guardian

**4.1 What a Guardian is.** A Guardian is a service run by a Guardian Operator that (a) keeps an encrypted copy of your account state, (b) provides an acknowledgement signature ("ACK") on transactions you authorize, and (c) helps you restore account state to a new device. The Guardian Operator holds its own Guardian key. That key is not one of your keys, does not count toward your account's signing threshold, and cannot move your assets. The ACK is a separate check your account performs in addition to verifying your own signatures.

**4.2 Who the Guardian Operator is.** Four independent Guardian Operators run Guardian services for the Miden partner mainnet; their live status is shown at guardians.miden.xyz. At launch they are LambdaClass (FOLTREK SA), KODA (Korea Digital Asset Co., Ltd.), Para (Capsule Labs Inc.) and Gateway.fm (GATEWAY.FM AS). When you create a wallet, Bread Wallet measures the response time of each operator on the list and assigns you the fastest one. The app shows you which operator was assigned, and you can change it at any time (4.5). Your Guardian Operator is a separate party from us. During the partner mainnet phase there are no separate service terms between you and your Guardian Operator; this section 4 describes what the operator does and does not do. If an operator introduces its own terms, we will tell you in the app and you may rotate to another operator before they apply (4.8). We are not responsible for a Guardian Operator's acts or omissions except where the Guardian Operator is Miden or an affiliate.

**4.3 What the Guardian stores.** Your Guardian Operator stores an encrypted copy of your account state and nothing else about you. It collects no identity, contact or compliance data from you, and it does not store your Everyday Key or your Recovery Phrase. How this data is handled is described in the Privacy Policy and in the Guardian Operator's own privacy notice.

**4.4 ACK and pause.** When you authorize a transaction, your Guardian Operator signs the same transaction summary that you sign. A Guardian Operator is expected to decline to sign (a "pause") only where it has reason to believe your account or device is compromised, or where a lawful request requires it. Technically, an operator can pause your account at its discretion, and we do not control when it does. During a pause, transactions that require an ACK fail. A failed transaction is your notice of a pause; the app does not currently tell you that a failure was caused by a pause. A pause does not move your assets and does not change your credentials. Your remedy against a pause, whatever its reason, is rotation to another operator (4.5).

**4.5 Your rotation right.** You may replace your Guardian Operator with another, or with none where the app allows it, at any time. Rotation is a transaction signed with both your Everyday Key and your Recovery Phrase. It does not require your Guardian Operator's ACK, cooperation or consent at the protocol level. This is the mechanism that keeps the Guardian a service to you rather than a controller of your account. To build a rotation transaction you need a current copy of your account state (3.3).

**4.6 Recovery.** On a new device, your Guardian Operator can return your encrypted account state to you. Decrypting and using it requires a key you still control. You can also restore your account state from an Encrypted Wallet File you saved (3.5), which does not involve your Guardian Operator. Your Guardian Operator cannot restore keys and cannot give anyone else access to your account.

**4.7 Unavailability and data loss.** Guardian services can become unavailable through outage, termination, insolvency, legal order or data loss. The allocation is: (a) we and the Guardian Operator do not guarantee availability of the Guardian service; (b) if your Guardian Operator's copy of your account state is unavailable or lost and you hold no other current copy or backup, you may be unable to transact, including unable to rotate, even though you still hold your keys; (c) Bread Wallet keeps a copy of your account state on your device and lets you save it in an Encrypted Wallet File (3.5); if you lose your device without a current file, your Guardian Operator's copy is the only remaining copy, and with a current file and a saved Everyday Key pair you can restore and rotate without the operator; (d) neither we nor the Guardian Operator is liable for losses from Guardian unavailability or data loss except as set out in section 17.

**4.8 Changing Guardian Operators by us.** We may change the list of Guardian Operators at any time, including adding or removing operators. We cannot rotate your Guardian for you, and no operator can move you to another operator; only you can, with both your credentials (4.5). If your operator is being removed from the list, or you want to leave it, you rotate to another operator in the app. Rotation takes a few minutes and your assets are unaffected. Where we remove an operator in a planned way, or an operator introduces a fee, we will tell you in the app and give you at least 30 days to rotate before the change takes effect. Where an operator becomes unavailable without notice, 4.7 applies.

## 5. Earn

**5.1 What Earn is.** Earn lets you place assets held on Miden into a lending position on an EVM network, in a market such as Aave, Compound, Morpho or a similar protocol (the "Earn Protocol"; the markets available are shown in the app). The position is recorded at an EVM address that belongs to you. Bread Wallet derives that address and its key from your Recovery Phrase when your account is created, stores the key encrypted on your device, and signs EVM transactions with it on your device; the key never leaves your device. Restoring from your Recovery Phrase restores the EVM key too, with or without a Guardian. During the partner mainnet phase, Earn positions are held on the Ethereum network. Epoch, operated by SYNC TECH LLC, a limited liability company of St. Vincent and the Grenadines, Euro House, Richmond Hill Road, Kingstown, St. Vincent and the Grenadines, mailing address P.O. Box 2897, Kingstown, St. Vincent and the Grenadines (the "Earn Provider") quotes the route, provides the liquidity on the EVM side, executes the deposit and the withdrawal, and settles with you on Miden. The Earn Protocol records your position and pays whatever yield it pays. Bread Wallet is an interface. We do not take deposits, hold your Earn assets, set rates or pay returns, and we receive no part of the yield or of Epoch's fees.

**5.2 How a deposit works.** You choose an amount and a market and see a quote with the expected net result. Bread Wallet then creates a public note on Miden addressed to Epoch for the deposit amount, bound to that exact order and carrying a reclaim height. Epoch executes the deposit on the EVM network and only then consumes the note. If Epoch never executes, the note stays unconsumed and you can reclaim it yourself once the reclaim height is reached. Because the funding note is public, the deposit amount and your Miden account are visible on the network.

**5.3 How a withdrawal works.** You choose an amount of the underlying asset to withdraw and see a quote with a minimum payout. Bread Wallet signs the EVM transactions that take the assets out of the market and place them in a settlement lock. Epoch then delivers a payout note to your Miden account, and only after that delivery has been verified may Epoch claim the locked EVM assets. If the EVM steps partly fail, assets may remain at your EVM address or in the settlement lock. Bread Wallet tracks each step separately and shows you where your assets are; if a recovery step is needed, contact us (section 23) and we will help you complete it. Withdrawals depend on the market's liquidity and exit rules and may be delayed or unavailable.

**5.4 Rates are variable and not guaranteed.** Any rate, APY or projected return shown in Bread Wallet is an estimate based on current conditions in the lending market. Rates change continuously and may fall to zero. Past rates do not predict future rates. Neither we nor Epoch guarantees any return; the lending market's rules determine what, if anything, you receive.

**5.5 Fees.** Epoch charges a fee of 0.15% (15 basis points) on each transaction it executes for you, so a deposit and a later withdrawal are charged separately. Epoch pays the Ethereum transaction costs of a withdrawal and does not charge you for them. The lending market's own fees, any exchange fees on a route that converts assets, and Miden network fees are separate. Each quote shows the fee, the routing costs and the net amount before you confirm. We take no fee on Earn (section 9).

**5.6 Risks specific to Earn.** Deposited assets are subject to the lending market's smart-contract and solvency risk; to the risk that Epoch cannot execute or settle; to withdrawal delays or limits set by the market; to partial failure across two networks, which can leave assets at your EVM address or in the settlement lock until recovered; to price movement and slippage on any route that converts assets; and to loss of both your device and your Recovery Phrase, which also loses the EVM key that owns the position. You may receive back less than you deposited. Earn is not a bank deposit and is not insured or guaranteed by any government scheme.

**5.7 Withdrawal.** You may request withdrawal through Bread Wallet while wallet access is permitted under section 11. A deposit and a withdrawal are separate orders with separate quotes. Processing time depends on both networks and on the market, and may be longer than for a transaction on Miden alone.

**5.8 Open positions on suspension or termination.** Your position is held at your EVM address in the lending market, not in Bread Wallet and not with Epoch. If we suspend or terminate your access to Bread Wallet, or withdraw the Earn feature, the position is unaffected. Because the EVM key derives from your Recovery Phrase, you can also recover the position with any wallet that supports the same key derivation as Bread Wallet. If Epoch stops providing the service, you can still withdraw on the EVM side with your EVM key, and you can return assets to Miden through another route (section 6). We have no obligation to make you whole for anything that happens in the lending market or at Epoch.

**5.9 Availability.** New Earn deposits are not available to residents of the United Kingdom or of the State of New York and are blocked for connections from those places. This Earn-specific restriction permits withdrawals while wallet access is allowed under section 11. We may add or remove jurisdictions, markets and networks at any time.

## 6. Swaps, bridges and solver routing

**6.1 Swaps.** Bread Wallet offers two kinds of swap. A **Miden swap** exchanges one asset for another on the Miden network. It is filled by a solver operated by 0D Labs Limited, a company limited by shares organised under the laws of Seychelles (LEI 254900SN1Y7P2AYYLK22) with its registered address at c/o Overseas Management Company (Seychelles) Limited, Oliaji Trade Centre, 1st Floor, Victoria, Seychelles ("0D Labs"), a party other than us: when you accept a Miden swap quote you are trading with 0D Labs as your counterparty, at the quoted rate, and it is bound by the quote once you confirm. Any spread or fee of the solver is included in the quoted rate (9.1); we receive none of it. A **cross-chain swap** sends one asset from another network and delivers a different asset on Miden, or the reverse, through NEAR Intents (6.4); it is filled by a third-party solver, and we are not a party to it. In both cases you see a quoted amount and set a minimum amount you are willing to receive before you confirm. We do not guarantee that a cross-chain quote will be filled.

**6.2 Routing discretion.** We choose which Solvers, bridges and liquidity sources Bread Wallet connects to and may change them at any time. Where several routes exist, Bread Wallet shows you the route and the quoted result before you confirm. We do not receive fees, rebates or other payments from Solvers or bridge operators.

**6.3 Slippage and price movement.** Market prices move between quote and settlement. You may receive less than the quoted amount, down to the minimum you set. A quote is not a guaranteed price.

**6.4 Bridges.** Moving assets between Miden and another network uses one of the routes below. Each is operated by a party other than us, except where the table says otherwise. While in transit, your assets are held by that route's contracts or solver, not by us.

| **Route** | **Operated by** | **Used for** | **How your assets move** | **Time** | **If it fails** |
|---|---|---|---|---|---|
| Agglayer bridge | The Agglayer bridge's operators, not us | Deposits to and withdrawals from Miden | Your assets are held by the bridge's contracts on the origin network until they are released or issued on the destination | Shown in the app before you confirm; delays are possible | Where the route supports it, the app lets you reclaim a failed transfer; otherwise 6.5 applies |
| NEAR Intents | The NEAR Intents protocol and independent solvers | Cross-chain transfers and cross-chain swaps | You deposit on the origin network; a solver fills the order and delivers on the destination | Shown in the app before you confirm; delays are possible | An unfilled order is returned under the protocol's rules; 6.5 applies |
| Epoch (Fast) | Epoch (SYNC TECH LLC) | Fast deposits to Miden | Epoch provides liquidity on Miden and settles on the origin network | Shown in the app before you confirm; delays are possible | 6.5 applies |
| USDCx via CCTP | Circle (CCTP attestation and the xReserve on Arc) and the USDCx contract on Miden | Moving USDC to and from Miden as USDCx; the bridge leg of every Transak on-ramp and off-ramp (section 7) | USDC is burned on the origin network and attested by Circle; USDCx is issued on Miden against USDC held in Circle's xReserve, and the reverse on the way out | Shown in the app before you confirm; depends on Circle's attestation | If Circle's attestation does not match the deposit or delivery times out, the app shows the failed transfer and 6.5 applies |

**6.5 Failed, stuck or undelivered transfers.** If a swap or bridge transfer fails before your assets leave your account, the assets remain yours and nothing is owed. If assets leave your account but the transfer does not complete, the app lets you reclaim the funds of a failed bridge transfer where the route supports it. For a Miden swap, we return your assets if we cannot fill the order. In any other case we will help you trace the transfer, but we cannot guarantee recovery and have no obligation to refund or replace assets held by a third-party solver, bridge or other network.

**6.6 Finality.** A transaction on Miden is final when it is included in a block that the network treats as final. During the partner mainnet phase the network operator can halt the network and revert to an earlier block in response to a security incident. A transaction you believed complete may then be undone, and assets you received may be returned to the sender. Section 10 describes this risk further.

**6.7 No obligation to offer swaps or bridges.** We may suspend or withdraw swap and bridge features at any time, including for individual assets or regions.

## 7. Fiat on-ramp and off-ramp via Transak

**7.1 Who you deal with.** Buying crypto with fiat (on-ramp) and selling crypto for fiat (off-ramp) in Bread Wallet is provided by Transak through a widget embedded in the app. When you use it you open an account with, and transact with, the Transak entity for your country of residence under [Transak's Terms of Service](https://transak.com/terms-of-service). For residents of the UK and of countries not otherwise listed that is Transak Limited, a UK company registered with the Financial Conduct Authority as a cryptoasset firm; U.S. residents deal with Transak USA LLC under [Transak's U.S. terms](https://transak.com/terms-of-service-us) (Transak Terms 5.1). We are not a party to your transaction with Transak, do not receive or hold your fiat, and are not a payment service provider.

**7.2 How it works.** Transak does not operate on the Miden network. Both directions therefore use the EVM address that Bread Wallet derives from your Recovery Phrase (section 5.1) as your Transak wallet, with a bridge leg between that address and Miden (section 6). The asset is USDC on the Ethereum network, and the bridge leg is the USDCx route via CCTP (6.4). On-ramp: you pay fiat to Transak and Transak sends USDC to your EVM address. Bread Wallet then completes the bridge to Miden for you: you sign a single transaction from your EVM address that authorizes the bridge transfer to your Miden account, and we submit it to the Ethereum network and pay the Ethereum gas; we do not recover that cost from you. You see the full flow before you confirm the Transak purchase. Off-ramp: you first bridge USDCx from Miden to USDC at your EVM address, with the Ethereum gas again paid by us; then you create a sale order, the USDC is sent from that address to Transak within the time limit Transak sets, again by a transaction you sign and we submit and pay gas for, and Transak pays fiat to your verified bank account (Transak Terms 11.1). You do not need to hold ETH at your EVM address for any step. We may stop paying gas on your behalf at any time; if we do, the gas cost will be shown before you confirm. Between the legs your assets sit at your EVM address, which only your key controls, or in transit in the bridge (6.4). Each leg has its own counterparty, fees, timing and failure modes.

**7.3 Identity verification.** Transak must verify your identity before you can transact and will not provide its service until verification is complete (Transak Terms 9.1). Identity verification is performed entirely by Transak. Transak collects identity documents and bank details directly; we do not receive, store or have access to them, and we do not verify your identity ourselves. Transak links your verified identity to your EVM address, and transfers between that address and your Miden accounts are visible on the networks involved. We do not use Transak's KYC-reliance or identity pass-through features.

**7.4 Sanctions and compliance controls.** Transak screens its users and transactions and requires each user to comply with OFAC, EU and UN sanctions (Transak Terms 6.3). Separately, our own controls apply to the Miden side of any transaction: the USDCx blocklist (section 8) and geographic restrictions (section 11). A transaction can therefore be declined by Transak, by the network, or by both, and declining is your notice.

**7.5 Pricing and fees.** Transak sets its exchange rate from market sources with a spread (Transak Terms 12.1) and shows its fee before you confirm (Transak Terms 14.2). Transak's website states a flat 1% Transak fee and that partners may add their own fee. Bread Wallet adds no partner fee. The bridge leg carries its own fees (sections 6 and 9), so a full on-ramp or off-ramp costs the Transak fee plus any bridge fee plus network fees. During the partner mainnet phase we pay the Ethereum gas for the bridge transactions on both the on-ramp and the off-ramp, and do not recover it from you.

**7.6 Failed, rejected and mistaken transactions.** Transak may reject an order, including for price movement or order size, and may charge a processing fee to return your crypto on a rejected sale (Transak Terms 11.1). Crypto sent to a wrong address, or to Transak without a sale order, may be unrecoverable. Once Transak has paid fiat to your bank account the payment cannot be refunded (Transak Terms 11.3). We cannot reverse, refund or accelerate any Transak transaction.

**7.7 Wallet ownership.** Transak requires you to attest that you are the sole owner of the wallet address you use and that no other person has access to or control over it (Transak Terms 11.4). The address you use with Transak is your EVM address, which is controlled by a key derived from your Recovery Phrase and held only on your device; no Guardian Operator and no other party can sign for it.

**7.8 Limits and availability.** Transak applies transaction limits that depend on payment method, verification level and country (Transak Terms 7.1(c)). Transak's off-ramp is available in a limited set of countries; availability in the app does not mean availability for you.

## 8. USDCx and on-chain compliance controls

**8.1 What USDCx is.** USDCx is a token on the Miden network that represents USDC held in Circle's xReserve contract on Arc, Circle's own network. One USDCx is issued when one USDC is deposited into that reserve, and USDCx is burned when the underlying USDC is released. USDC coming from or going to the Ethereum network travels through CCTP (6.4). USDCx is also the asset in which network fees are paid (section 9).

**8.2 Who issues USDCx and what you hold.** USDCx is a bridged representation of USDC on the Miden network. It is not issued by Circle, and Circle's USDC terms do not apply to it. The USDCx contract on Miden is deployed and administered by the Foundation, as network operator, itself or through its contractor (1.1). Holding USDCx gives you the ability to redeem it for USDC through the reserve mechanism described in 8.1, subject to the blocklist (8.3), any pause (8.4) and applicable law; that redemption runs through Circle's reserve contract but does not give you a contractual claim against Circle. USDCx is not legal tender, is not a deposit, and is not insured by any government scheme.

**8.3 Blocklist.** The USDCx contract enforces a blocklist administered by an authorized freeze manager, currently Predicate. Addresses designated on applicable sanctions lists are added automatically. If your address is blocked, transactions involving that address are denied; denial is your notice of blocked status and we are not obligated to give advance notice. Blocked USDCx cannot be sent, received or bridged. Unblocking occurs only where consistent with applicable law, as described in the Prohibited-User Disclosure. These controls operate at the asset layer and apply whatever interface you use.

**8.4 Pause.** The USDCx contract can be paused by the Foundation, as network operator, and by Circle, as operator of the reserve, each acting independently, in response to a security incident, a legal requirement or a migration (8.5). While paused, USDCx cannot be transferred. Because network fees are paid in USDCx, a pause also stops ordinary transactions on the network for its duration.

**8.5 Contract migration.** During partner mainnet the USDCx contract may be replaced. In a migration, balances are re-issued on the new contract according to a process the Foundation publishes before any migration, and the blocklist carries over. We will tell you in the app if you need to do anything.

**8.6 Depeg and reserve risk.** The value of USDCx depends on the reserve and on USDC itself. USDCx may trade below one U.S. dollar, and redemption may be delayed or unavailable if the bridge, the reserve or USDC is impaired. Section 10 sets out further risks.

## 9. Fees

**9.1 Where fees are shown.** We charge no fee of our own. The Miden network transaction fee is set by the network and collected by the Foundation as network operator (1.1); Bread Wallet passes it through unchanged. Where we pay a third-party network's gas on your behalf (7.2), we do not recover it. We charge nothing for Bread Wallet, bridging, Earn, Transak or the Guardian, and we receive no share of any third-party fee. A Miden swap quote includes any spread or fee of the solver, 0D Labs (6.1). All other fees are charged by third parties and passed through unchanged. Bread Wallet shows the network fee and any third-party fee (for swaps, for bridging via NEAR Intents, CCTP or Agglayer, for Earn, and for Transak) before you confirm a transaction. That display is the price disclosure for each transaction; there is no separate fee schedule.

| **Fee** | **Charged by** | **Amount** | **Paid in** | **Shown before you confirm?** |
|---|---|---|---|---|
| Network transaction fee | Miden network (collected by the Foundation as network operator) | Set by the network per transaction | USDCx | Yes |
| Miden swap spread or fee | 0D Labs, as solver | In the quoted rate | In the quoted rate | Yes, in the quote |
| Cross-chain swap fee or spread | Third-party solver | In the quote | Asset being swapped | Yes |
| Bridge fee | Bridge operator and destination network | In the quote | Asset being bridged | Yes |
| Earn fee or spread | Epoch | 0.15% per transaction, on deposit and on withdrawal; no gas charge | Deposited asset | Yes, in the Earn quote |
| Transak fee | Transak | Shown by Transak; its site states a flat 1% | Fiat or crypto per Transak | Yes, in the Transak widget |
| Guardian service fee | Guardian Operator | None during partner mainnet | Not applicable | Not applicable; any future fee would be shown before you confirm |

**9.2 Disclosure before confirmation.** Bread Wallet shows the total fee for a transaction before you confirm it. Third-party fees shown in a quote are passed through from the third party and may differ at settlement where the third party's terms allow.

**9.3 Non-refundable.** Fees are earned when a transaction is submitted and are not refundable, including for a transaction that later fails on the network or is reverted (6.6), except where applicable law requires a refund.

**9.4 Changes.** The network fee is set by the network and shown before each transaction; it may change without notice. Third-party fees change under the third party's terms.

## 10. Risk disclosures and experimental software

**10.1 Experimental software and early network.** Bread Wallet and the Miden network are at an early stage. The network is currently operated as a partner mainnet: a closed network run by a single operator, the Foundation (1.1), with a limited number of participants. During this phase the network operator can halt the network, revert to an earlier block, block addresses at the node level, and reset or migrate contracts. Software updates may be frequent and may change behavior. Bread Wallet may connect to test infrastructure. Do not use Bread Wallet with assets you cannot afford to lose.

**10.2 Specific risks.** By using Bread Wallet you accept the following risks, none of which we insure or guarantee against:

- **Smart-contract risk.** The Guardian account component, the USDCx contract, the blocklist component, swap notes and any Earn Protocol are code. Code can contain defects that lose or lock assets. Audits reduce but do not remove this risk. The Miden VM and cryptography libraries have been audited by Trail of Bits, the Miden transaction kernel and protocol by OpenZeppelin, and the Agglayer bridge by Spearbit. OpenZeppelin has also audited the USDCx contract, including its blocklist component. The Guardian account component and the Guardian service software have not been audited. Bread Wallet itself has not been audited. Other components have not been audited unless we say so.

- **Bridge risk.** Bridged assets depend on the bridge's contracts and operators and on the other network. Bridges have been a frequent target of attacks across the industry.

- **USDCx issuer and depeg risk.** USDCx depends on its reserve, on USDC and on the entities operating the bridge and reserve. It can lose its peg, be paused, be blocklisted, or become unredeemable (section 8).

- **Prover and infrastructure reliance.** Transacting on Miden requires generating a proof. If proving is delegated to a remote prover and that prover is unavailable, you may be unable to transact. The same applies to the network's RPC nodes and to your Guardian Operator.

- **Guardian reliance.** A Guardian pause or outage can delay your transactions until you rotate (section 4). If you lose your device while your Guardian Operator is unavailable, you can restore your account only from a current Encrypted Wallet File together with a saved Everyday Key pair; otherwise you wait until the operator is available again (section 3.4).

- **Privacy limits.** During the partner mainnet phase your transaction data, including data about private accounts and notes, is stored encrypted by the network's validators and can be decrypted when two validators cooperate; the validators are run by the Foundation, Gateway.fm and LambdaClass, none of which is us, and no single one of them can decrypt alone (section 12). Privacy features do not hide your activity from the network operator or from a court order served on it.

- **Regulatory risk.** Assets may be frozen, features may be withdrawn from your region, and the legal treatment of USDCx, Earn or the Guardian may change.

- **Key loss.** Loss of your keys is permanent (section 3).

- **Price and liquidity risk.** Digital assets are volatile and may be illiquid.

- **Tax.** You are responsible for any taxes on your transactions.

**10.3 No advice.** Nothing in Bread Wallet is investment, legal, tax or financial advice. We do not recommend any asset, swap, Earn position or counterparty.

## 11. Geographic restrictions

**11.1 Blocked jurisdictions.** The network's sequencer is geoblocked for the comprehensively sanctioned jurisdictions listed in the Sanctions Compliance Statement. Bread Wallet additionally applies the broader application access policy in that Statement: all wallet access, including withdrawals, is blocked for connections from Cuba, Iran, North Korea, Russia, Belarus, Crimea, Sevastopol and the whole Donetsk, Luhansk, Kherson and Zaporizhzhia oblasts of Ukraine. The App checks eligibility once at startup and keeps the decision for the page session. Without a successful startup eligibility decision, the wallet opens with Earn and Swap unavailable.

**11.2 Feature-level restrictions.** Individual features may be unavailable in further jurisdictions. Current restrictions: new Earn deposits are not available in the United Kingdom or the State of New York and are blocked for connections from those places, while withdrawals remain available where wallet access is permitted (5.9); Transak on-ramp and off-ramp are available only in the countries Transak supports (7.8). We may change these at any time.

**11.3 No circumvention.** You may not use VPNs, proxies or other means to circumvent geographic or compliance restrictions. Attempting to do so is a material breach of these Terms.

## 12. Network data, operator visibility and privacy

**12.1 Designed for privacy, operated with visibility.** Miden is designed to support private transaction execution. During the network's current operating period, the transaction data you submit, including data associated with private accounts and private notes, is stored by the network's validators in encrypted form. Any two validators acting together can decrypt it. During the partner mainnet phase there are three validators, operated by the Foundation, Gateway.fm and LambdaClass. We operate no validator and cannot decrypt your transaction data. The Foundation cannot decrypt it on its own either: decryption requires two validators to cooperate, so at least one party independent of the Foundation must agree, and it takes place only for network-integrity, compliance and legal purposes, including in response to a lawful request. We will tell you in the app and update these Terms when this changes.

**12.2 Who else sees data.** Your Guardian Operator holds the data described in 4.3. Transak holds the data described in 7.3. Solvers and bridge operators see the transactions they process. Each party's handling of your data is described in our Privacy Policy and in that party's own privacy notice.

**12.3 Records and disclosure.** We retain compliance-related records, including block and unblock records, for at least five years. We may disclose information where required by law or lawful process, including to sanctions authorities and courts.

**12.4 Privacy Policy.** Our Privacy Policy at [https://0xmiden.github.io/wallet/privacy/](https://0xmiden.github.io/wallet/privacy/) describes what personal data we collect, why, who receives it, how long we keep it, and your rights. It forms part of these Terms.

## 13. Acceptable use

You agree not to use Bread Wallet: (a) to violate any applicable law, including sanctions and export-control laws; (b) to engage in money laundering, terrorist financing, fraud or market manipulation, including manipulating Solver quotes or Earn rates; (c) to interact with addresses or contracts you know to be associated with illicit activity; (d) to interfere with or disrupt the network, a Guardian Operator, a Solver, a bridge, Transak or other users; (e) on behalf of another person, except where you hold a legal authority to act for them and have told us; or (f) to reverse engineer, decompile or misuse the software except as permitted by law or by the open-source licenses that apply to distributed components.

## 14. Third-party services and assets

**14.1 Third parties you interact with.** Bread Wallet displays or connects to services and assets provided by others, including the Foundation as network operator (sections 1.1, 8 and 12), Guardian Operators (section 4), the Earn Provider (section 5), Solvers and bridge operators (section 6), Transak (section 7), the USDCx reserve and bridge (section 8), and the Apple App Store, Google Play and Chrome Web Store through which the app is distributed. Each is a separate party. We do not control them and are not responsible for their availability, performance, security or terms. Your agreement with each of them is between you and that party.

**14.2 Assets.** We do not issue, endorse or vouch for any asset shown in Bread Wallet. Digital assets are volatile and you bear all risk of loss.

**14.3 Links and content.** Third-party content and links in the app are provided for convenience and are not endorsements.

## 15. Intellectual property; license; app store terms

**15.1 Ownership.** Miden and its licensors retain all rights in Bread Wallet and its content, except for components released under open-source licenses, which are governed by those licenses.

**15.2 License.** We grant you a limited, revocable, non-exclusive, non-transferable license to use Bread Wallet in accordance with these Terms, on devices that you own or control.

**15.3 Additional terms for the Apple App Store.** If you obtained Bread Wallet from the Apple App Store, the following also apply, as required by [Apple's minimum terms for a developer EULA](https://www.apple.com/legal/internet-services/itunes/dev/minterms/):

1. These Terms are between you and Miden only, not Apple. Miden, not Apple, is solely responsible for Bread Wallet and its content. These Terms do not set usage rules that conflict with the Apple Media Services Terms and Conditions.

2. Your license is limited to a non-transferable license to use Bread Wallet on Apple-branded products that you own or control, as permitted by the Usage Rules in the Apple Media Services Terms and Conditions, except that the app may be accessed by other accounts associated with you via Family Sharing or volume purchasing.

3. Miden is solely responsible for any maintenance and support of Bread Wallet. Apple has no obligation to furnish any maintenance or support services.

4. Miden is solely responsible for any product warranties, express or implied by law, to the extent not disclaimed. If Bread Wallet fails to conform to an applicable warranty, you may notify Apple and Apple will refund the purchase price (if any) to you. To the maximum extent permitted by law, Apple has no other warranty obligation, and any other claims, losses, liabilities, damages, costs or expenses attributable to a failure to conform to a warranty are Miden's sole responsibility.

5. Miden, not Apple, is responsible for addressing any claims by you or a third party relating to Bread Wallet or your possession or use of it, including product liability claims, claims that it fails to conform to a legal or regulatory requirement, and claims under consumer protection, privacy or similar legislation.

6. If a third party claims that Bread Wallet or your use of it infringes that third party's intellectual property rights, Miden, not Apple, is solely responsible for the investigation, defense, settlement and discharge of the claim.

7. You represent and warrant that you are not located in a country subject to a U.S. Government embargo or designated a "terrorist supporting" country, and that you are not on any U.S. Government list of prohibited or restricted parties (see also 2.3).

8. Questions, complaints and claims should be directed to the contact details in section 23.

9. You must comply with applicable third-party terms when using Bread Wallet (see 1.3).

10. Apple and Apple's subsidiaries are third-party beneficiaries of these Terms. On your acceptance, Apple has the right, and is deemed to have accepted the right, to enforce these Terms against you as a third-party beneficiary.

## 16. Disclaimers

BREAD WALLET IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SOFTWARE, THE NETWORK, ANY GUARDIAN SERVICE, ANY SOLVER OR BRIDGE, THE EARN PROTOCOL OR TRANSAK WILL BE AVAILABLE, UNINTERRUPTED, ERROR-FREE OR SECURE; THAT ANY TRANSACTION WILL BE FILLED, SETTLED OR FINAL; THAT ANY RATE SHOWN IN EARN WILL BE PAID; OR THAT ANY ASSET WILL RETAIN VALUE, REMAIN TRANSFERABLE OR REMAIN REDEEMABLE. NOTHING IN THIS SECTION EXCLUDES A WARRANTY THAT CANNOT BE EXCLUDED UNDER THE LAW OF THE COUNTRY WHERE YOU LIVE (SECTION 21.3).

## 17. Limitation of liability

**17.1 Exclusion.** TO THE MAXIMUM EXTENT PERMITTED BY LAW, MIDEN AND ITS AFFILIATES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR ANY LOSS OF ASSETS, DATA, PROFITS OR VALUE, ARISING FROM OR RELATING TO YOUR USE OF BREAD WALLET, INCLUDING LOSSES RESULTING FROM: COMPLIANCE ACTIONS SUCH AS BLOCKING, PAUSING OR TRANSACTION DENIAL; GUARDIAN UNAVAILABILITY, PAUSE OR DATA LOSS; FAILED, DELAYED OR REVERTED SWAPS, BRIDGE TRANSFERS OR NETWORK TRANSACTIONS; EARN RETURNS OR LOSSES; TRANSAK TRANSACTIONS; OR LOSS OF KEYS OR ACCOUNT STATE.

**17.2 Cap.** OUR AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO BREAD WALLET SHALL NOT EXCEED USD 1,000.

**17.3 Third parties.** We are not liable for the acts or omissions of the Foundation as network operator, Guardian Operators, Solvers, bridge operators, the Earn Provider, Transak or any other third party (section 14), except where the third party is Miden or an affiliate acting in that role.

**17.4 What we do not exclude.** Nothing in these Terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any other liability that cannot be excluded or limited under applicable law, including the consumer protection law of the country where you live (section 21.3).

## 18. Indemnification

You will indemnify and hold harmless Miden and its affiliates, officers, employees and agents from claims, losses and expenses (including reasonable attorneys' fees) arising from your use of Bread Wallet, your violation of these Terms, or your violation of applicable law, including sanctions laws. This section does not apply to the extent it would be unenforceable against a consumer under the law of the country where you live (section 21.3).

## 19. Suspension and termination

**19.1 What we can suspend or terminate.** We may suspend or terminate your access to the Bread Wallet application and to the features we operate at any time, with or without notice, including where required by law, where we believe you are a Prohibited User, or where you breach these Terms. We may also withdraw a feature, a region or the app as a whole.

**19.2 What termination does not do.** Termination ends your license to use our software. It does not and cannot: (a) take, freeze or move assets in your on-chain accounts, which remain controlled by your keys; (b) revoke your Guardian Operator's obligations to you under its own terms; or (c) close an Earn position, a pending swap or a Transak order, each of which continues under the relevant third party's terms. Compliance controls that operate at the asset or network layer (sections 8 and 11) are separate from termination and continue to apply.

**19.3 Access to your assets after termination.** After termination you can access your accounts with any software compatible with the Miden network. Where we withdraw the app or a feature entirely, we will keep a withdraw-only mode available for at least 90 days after notice so that you can move assets, close Earn positions and rotate or disable your Guardian, subject to the wallet access restrictions in section 11. That mode does not bypass those restrictions.

**19.4 Survival.** Sections 3, 4.7, 8, 9.3, 10, 12, 14 and 16 to 22 survive termination.

## 20. Changes to these Terms

We may modify these Terms by posting an updated version at [https://0xmiden.github.io/wallet/tos/](https://0xmiden.github.io/wallet/tos/) with a new effective date. For material changes we will give at least 30 days' notice in the app before they take effect, except where a change is needed to comply with law or to address a security risk, in which case we will give as much notice as we reasonably can. Continued use after a change takes effect constitutes acceptance. If you do not accept a change, stop using Bread Wallet before it takes effect; section 19.3 applies to your assets.

## 21. Governing law, disputes and consumer rights

**21.1 Governing law.** These Terms are governed by the laws of the State of Delaware, United States, without regard to its conflict-of-laws rules.

**21.2 Disputes for users outside the EU, EEA and UK.** If you are not a consumer resident in the European Union, the European Economic Area or the United Kingdom, any dispute arising out of or relating to these Terms or Bread Wallet shall be brought exclusively in the state or federal courts located in the State of Delaware, and you and we each submit to the jurisdiction of those courts. Before starting proceedings, you agree to contact us at the address in section 23 with a written description of the dispute and to give us 30 days to resolve it informally.

**21.3 Consumers in the EU, EEA and UK.** If you are a consumer resident in the European Union, the European Economic Area or the United Kingdom, section 21.2 does not apply to you. You may bring any dispute in the courts of the country where you live, and we will bring proceedings against you only in those courts. Nothing in these Terms, including the choice of law in 21.1, deprives you of the protection of provisions of the law of your country of residence that cannot be derogated from by agreement. Where a term of these Terms conflicts with such a provision, the provision prevails for you.

**21.4 Complaints.** Complaints can be sent to the contact in section 23.

## 22. General provisions

**22.1 Entire agreement.** These Terms, together with the documents incorporated in 1.2, are the entire agreement between you and us about Bread Wallet and supersede any earlier terms. They do not affect any separate agreement you have with a third party named in section 14.

**22.2 Severability.** If any provision of these Terms is held invalid or unenforceable, it will be enforced to the maximum extent permitted and the remaining provisions remain in full force.

**22.3 Assignment.** You may not assign or transfer these Terms or any rights under them. We may assign these Terms to an affiliate or to a successor in a merger, acquisition or sale of assets, and will notify you in the app.

**22.4 Force majeure.** We are not liable for any failure or delay caused by events beyond our reasonable control, including network outages, actions of the network operator or a third party named in section 14, changes in law, sanctions designations, cyber-attacks, or failures of internet or cloud infrastructure.

**22.5 No waiver.** Our failure or delay in enforcing any provision is not a waiver of it.

**22.6 Third-party beneficiaries.** Except for Apple and its subsidiaries under 15.3, no third party has any right to enforce these Terms.

**22.7 Notices.** We may give you notice in the app, by email to an address you have given us, or by posting at [https://0xmiden.github.io/wallet/tos/](https://0xmiden.github.io/wallet/tos/). Notices to us go to the address in section 23. Notice by email is deemed received on the business day it is sent.

**22.8 Language.** These Terms are written in English. Any translation is for convenience; the English text prevails.

**22.9 Export control.** You will comply with applicable export-control laws in using Bread Wallet.

## 23. Contact

Miden Technologies (US) Corp., 850 New Burton Road, Suite 201, Dover, Delaware 19904-5786, United States. Questions, complaints and claims: [privacy@miden.team](mailto:privacy@miden.team), telephone +1 707 813 2275. Blocked-address inquiries: the same contact, handled as described in the Prohibited-User Disclosure.
