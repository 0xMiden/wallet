# Earn partial withdrawals implementation plan

**Goal:** Implement wallet #1491 against the current amount-capable Epoch Testnet market.
**Spec:** https://github.com/0xMiden/wallet/issues/1491
**Architecture:** Reuse AmountInput/SubPageLayout and the existing persisted withdrawal lifecycle. Carry exact decimal strings to review, obtain an unsigned delivery quote, recheck owner/availability/config before signing and bind prepared delivery amount/minimum to review. Preserve existing recovery paths and compatibility with separate USDCx funding-choice work.
**Tech stack:** React, TypeScript, viem bigint conversion, Jest/RTL, Playwright.

## Constraints
No contract migration, seed import, live transaction, deployment or merge. PR publication was explicitly authorized after the implementation and UX review. The original verified base was 5625b76f30b41bd861439950d797dd14cd3e0a3f; the branch is updated to current main before publication. Separate funding-choice work and existing native simulators are left untouched.

## Review focus
- Token precision: 18-decimal EVM underlying versus 6-decimal native payout; no Number conversion in authorization.
- Stale availability, account/network/config switch and delayed quotes must invalidate review.
- Rapid confirm/retry must not duplicate submissions; existing durable submission lock remains authoritative.
- Tiny amounts need positive minimum delivery; no zero-floor quote.
- Full withdrawal/recovery must remain reachable; received lifecycle keeps actual amount/history and refreshes remaining position.

## Tasks
- [x] Add exact amount validation tests (positive, Max, tiny, zero, negative, precision, over-balance and uint256 bound); run red, implement bigint parsing.
- [x] Add unsigned quote and guard tests; bind owner, account, network, market, faucet, source atomic amount, minimum output, review expiry and availability. Test failure/changed quote before signing.
- [x] Add amount route and canonical controls; preserve exact Max. Add review quote/refresh/guard states and use selected amount for persisted submission. Test partial/Max, stale availability, failures and duplicate prevention.
- [x] Confirm remaining-position refresh follows terminal withdrawal, retain actual receipt history. Add focused regression where needed.
- [x] Run affected tests, TypeScript and production extension/mobile builds. Verify actual components in isolated browser viewports, record screenshots and distinguish mocks/simulations from live end-to-end evidence.
- [x] Record deployment mismatch, contract evidence, task-6 compatibility and remaining authorized-transaction acceptance.

## UX follow-up

Brian requested readable balance typography and a shorter review. Availability uses wallet display formatting. Max snapshots the exact full amount while presenting a short value and explicit full-balance label; edits replace that snapshot. Review leads with estimated native receipt, shows selected withdrawal, residual investment and minimum receipt, and places exact amounts/owner/route costs inside the shared DetailDisclosure. Use the existing Nunito type roles, semantic tokens and pinned footer; signing/quote validation remain unchanged. Focused tests cover Max display versus exact submission, edits, disclosure and residual amount. Revised browser screenshots use the production font loader and FullScreenPage; native/live acceptance stays separate.

## Contract capability evidence

Read-only checks on Sepolia (chain 11155111, simulation block 11926328) found that the wallet's patched Epoch SDK 1.0.39 accepts underlying base-unit amounts with `isAll=false`. An unsigned withdrawal quote targeted `0x1044b7aeE0e75a82d1d0DD7d4215d7A5ed312DD5`, selector `0xf3fef3a3` (`withdraw(address,uint256)`), rather than the graph/widget's advertised `0xa73c1ae0e4e9116020dba0a419f91585d73459ee`. The implementation follows the SDK quote and hardcodes neither target.

The underlying is 18-decimal USDC (`0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69`). Read-only eth_call simulations with synthetic receipt balances showed exact 1:1 underlying redemption: from 10e18 units, withdrawing 1 left 10e18-1, withdrawing 1e18 left 9e18, withdrawing 10e18-1 left 1, and Max left zero. Zero and over-balance reverted. These checks establish amount support and residual behavior under simulated state; they are not live transactions.

Delivery has a separate quote-dependent minimum. One underlying wei had no delivery quote; a quoted one-native-unit output would have a zero 99% floor and is refused. The UI requires a usable quote and positive minimum, and resolves native faucet/precision dynamically. No fixed minimum or share conversion is invented.

References: [Epoch Smart Withdraw SDK](https://docs.epochprotocol.xyz/integration-guides/sdk-reference#smart-withdraw-headless), [quoted Sepolia contract](https://sepolia.etherscan.io/address/0x1044b7aeE0e75a82d1d0DD7d4215d7A5ed312DD5).

## Visual and live acceptance limits

The committed screenshots are browser views with mocked services, using production components, FullScreenPage and bundled Inter/Nunito fonts. The preview covers readable Max, partial review, Details and light/dark layouts; it cannot sign or submit. Native keyboard/safe-area behavior and live partial/Max settlement, actual credit and legacy redemption still require a separately authorized wallet transaction session. Non-English strings retain the existing pending-translation English fallback.
