/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = readFileSync(resolve(__dirname, '../ios/tests/usdcx-live-deposit.ios.spec.ts'), 'utf8');

/** The source between two step names, so a check is pinned to the step that owns it. */
function between(from: string, to: string): string {
  const start = spec.indexOf(`'${from}'`);
  const end = spec.indexOf(`'${to}'`, start);
  if (start === -1 || end === -1) throw new Error(`the spec has no step '${start === -1 ? from : to}'`);
  return spec.slice(start, end);
}

describe('the live iOS USDCx spec', () => {
  // A wrong recipient strands the deposit at the faucet, so it must fail in seconds, not after Circle's 20 minutes.
  it("checks what the counterparty signed and the row's recipient before it waits on Circle", () => {
    expect(between('assert_deposit_broadcast', 'row_reaches_delivering')).toMatch(
      /remoteRecipient: recipient,\s*maxFee: 0n,\s*hookData: '0x'/
    );
    expect(between('row_reaches_delivering', 'circle_attests_deposit')).toMatch(/usdcxRemoteRecipient/);
  });

  // A dispatch sets the deposit amount; one the wallet will not claim unattended must fail before anything is sent.
  it('refuses a deposit the wallet would leave unclaimed before it pairs the counterparty', () => {
    expect(between('native_asset', 'connect_evm')).toMatch(/isWorthClaiming\(depositUnits, read\.baseFee\)/);
  });

  // R24: an Arc URL can carry an API key in its path, and the evidence holds neither a key nor the password.
  it('names Arc endpoints by host and writes the evidence only through its refusal of secrets', () => {
    expect(spec).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(spec).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
    expect(spec).toMatch(/fs\.writeFileSync\(evidencePath, evidenceBody\(evidence, secrets\)\)/);
  });

  // Circle's Arc payouts have run hours late, so the burn half comes last: it can redden a run only after the deposit
  // leg passed.
  it('burns only after the deposit leg and gates on the payout before the wallet confirmation', () => {
    const markers = [
      "'relayer_mints_and_wallet_claims'",
      "'arc_state'",
      "'grant'",
      'await payoutLeg(step,',
      "'burn_via_send'",
      'await waitForPayout(',
      "'wallet_confirms_payout'"
    ];
    const at = markers.map(marker => spec.indexOf(marker));
    expect(markers.filter((_marker, i) => (at[i] ?? -1) <= (i === 0 ? -1 : (at[i - 1] ?? -1)))).toEqual([]);
  });

  // R20: the payout refills the key the deposit spent, and the gate counts from the leg's read right before the burn.
  it('burns back to the deposit key and holds the wallet to the snapshot the payout gate counts from', () => {
    expect(between('settle_grant', 'burn_via_send')).toMatch(
      /key: \{ address: evmAddress,[\s\S]*takeKey: \(\) => depositKey,/
    );
    expect(between('burn_via_send', 'burn_completed')).toMatch(/destAddress: key\.address,/);
    expect(between('burn_completed', 'burn_consumed')).toMatch(/before: snapshot\.balance\.toString\(\)/);
  });
});
