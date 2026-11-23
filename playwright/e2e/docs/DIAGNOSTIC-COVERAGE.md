# Wallet nightly reporting

The scheduled Chrome extension workflow produces a `wallet-e2e/v1` artifact for each job that completes its reporting step. `scripts/wallet-e2e/run.sh` records each Playwright command's start and exit. The Playwright reporter keeps test attempts and wallet observations. `scripts/wallet-e2e/job.cjs` uses those records and Actions step outcomes to assemble the artifact, including partial reports. GitHub supplies the job ID and conclusion separately.

## How to read the report

- **Setup and recovery.** An earlier failure can block fresh swaps. A recovery claim can succeed with zero fresh starts. The report counts a start only when the wallet reaches fresh execution. A skipped forward step records zero. Missing evidence stays unknown.
- **Quote.** HTTP success and exact quote acceptance are separate stages. The report includes a bounded cause when the solver response establishes one. If route selection finds no candidate, it reports a specific quote refusal only when every evaluated candidate had the same refusal.
- **Swap.** Wallet confirmation and release of authorization do not establish standalone proof or network submission. Canonical inclusion of the original order is recorded even if the payback times out. Finding a payment note is distinct from claiming it. The report includes received funds and fees once wallet balance checks pass.
- **Bridges.** Epoch, NEAR, USDCx and AggLayer report progress at the checks for the selected route. Preparation, a completed leg and verified usable funds are separate observations. Provider and network fields require evidence from the run.

The schema allows fixed error explanations, public run IDs and approved token amounts. Wallet identifiers, raw errors, checkpoints, traces and credentials do not enter the artifact. A reporting failure leaves the original command's exit code and authorization checks in control.

Generate the sample recovery reports and a deliberately invalid example with:

```sh
node scripts/wallet-e2e/fixtures/generate.cjs /tmp/wallet-e2e-examples
```
