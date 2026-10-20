---
title: Miden Network — Legal & Compliance Disclosures
permalink: /compliance/
---

# Miden Network - Legal & Compliance Disclosures

## Part I - Sanctions Compliance Statement

Miden prohibits the use of the Miden network and all Miden-provided services, including Bread Wallet, the Faucet, the Bridge UI, and any Miden-hosted frontend, by any person or entity subject to sanctions administered by the U.S. Office of Foreign Assets Control (OFAC), the United Kingdom (UK Sanctions List), the European Union (EU Financial Sanctions / CSL), Israel (NBCTF designations), Japan (Economic Sanctions & Subject List), or France (Registre National des Gels), including persons located, organized, or resident in comprehensively sanctioned jurisdictions and entities owned or controlled by sanctioned persons (collectively, "Prohibited Users").

Miden's prevention model operates at three layers:

Infrastructure layer (network access). During the network's initial centralized phase, all transactions are submitted through Miden's sequencer. The sequencer's gRPC endpoint is geoblocked for comprehensively sanctioned jurisdictions, so access from those jurisdictions is denied at the network level regardless of the client, wallet, or frontend used. The Faucet, which submits transactions on users' behalf rather than through the user's own client, carries its own equivalent geoblocking.

Application layer. Miden-hosted frontends and Bread Wallet apply additional application-level restrictions, including geoblocking and exclusion of comprehensively sanctioned territories from app-store distribution, on top of the network-level controls above.

Asset layer. Assets issued on Miden may carry on-chain compliance controls enforced at the protocol level. USDCx, for example, is subject to an on-chain blocklist on its issuing faucet: addresses designated on the sanctions lists above are frozen automatically within minutes of designation by an authorized freeze manager, and blocked addresses cannot send, receive, or bridge the asset regardless of the interface used. Enforcement occurs within the transaction proof itself, so it does not depend on wallet or frontend behavior. Freeze and unfreeze actions are recorded, evidenced by on-chain transactions, and retained for a minimum of five (5) years consistent with 31 CFR 501.601.

Legal process. Requests from law enforcement and asset-restriction orders are received and serviced by Miden at ops@miden.team, with the cooperation of relevant service providers. Miden complies with lawful reporting requests in coordination with law enforcement.

## Part II - Prohibited-User Disclosure

The Miden network's hosted services, Bread Wallet, the Faucet, the Bridge UI, and any Miden-hosted frontend, and compliance-controlled assets such as USDCx may not be used by Prohibited Users, as defined in the Sanctions Compliance Statement. By using these services, you represent that you are not a Prohibited User and are not acting on behalf of one.

Access from comprehensively sanctioned jurisdictions is restricted at the network level through geoblocking of the sequencer endpoint, and additionally at the application level. Attempted access from those jurisdictions may be denied without notice.

For compliance-controlled assets, enforcement is immediate and automatic: if your address is included on an applicable sanctions list, transactions involving your address will be denied, and transaction denial is your notice of blocked status. Frozen assets cannot be transferred, received, or bridged. Miden is not obligated to provide advance notice of blocking. Persons who believe they have been blocked in error may contact ops@miden.team; unblocking occurs only where consistent with applicable law, including any required authorization from the relevant authority.

During the network's initial centralized operating period, the Miden operator has visibility into all transaction data, including private transactions, for network-integrity, compliance, and legal purposes.
