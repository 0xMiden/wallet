/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string): string => readFileSync(resolve(__dirname, path), 'utf8');
const arcSpec = read('../ios/tests/usdcx-live-deposit.ios.spec.ts');
const burnHalf = read('../ios/helpers/usdcx-live.ts');

/** The source between two step names, so a check is pinned to the step that owns it. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(`'${from}'`);
  const end = source.indexOf(`'${to}'`, start);
  if (start === -1 || end === -1) throw new Error(`no step '${start === -1 ? from : to}'`);
  return source.slice(start, end);
}

/** The markers that do not come after the one before them. */
function outOfOrder(source: string, markers: readonly string[]): string[] {
  const at = markers.map(marker => source.indexOf(marker));
  return markers.filter((_marker, i) => (at[i] ?? -1) <= (i === 0 ? -1 : (at[i - 1] ?? -1)));
}

describe('the live iOS USDCx spec on Arc', () => {
  // A wrong recipient strands the deposit at the faucet, so it must fail in seconds, not after Circle's 20 minutes.
  it("checks what the counterparty signed and the row's recipient before it waits on Circle", () => {
    expect(between(arcSpec, 'assert_deposit_broadcast', 'row_reaches_delivering')).toMatch(
      /remoteRecipient: recipient,\s*maxFee: 0n,\s*hookData: '0x'/
    );
    expect(between(arcSpec, 'row_reaches_delivering', 'circle_attests_deposit')).toMatch(/usdcxRemoteRecipient/);
  });

  // A dispatch sets the deposit amount; one the wallet will not claim unattended must fail before anything is sent.
  it('refuses a deposit the wallet would leave unclaimed before it pairs the counterparty', () => {
    expect(between(arcSpec, 'native_asset', 'connect_evm')).toMatch(/isWorthClaiming\(depositUnits, read\.baseFee\)/);
  });

  // R24: an Arc URL can carry an API key in its path, and the evidence holds neither a key nor the password.
  it('names Arc endpoints by host and writes the evidence only through its refusal of secrets', () => {
    expect(arcSpec).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(arcSpec).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
    expect(arcSpec).toMatch(/fs\.writeFileSync\(evidencePath, evidenceBody\(evidence, secrets\)\)/);
  });

  // Circle's Arc payouts have run hours late, so the burn half comes last; R20: it pays the deposit key back.
  it('burns back to its own deposit key, only after the deposit leg', () => {
    expect(
      outOfOrder(arcSpec, ["'relayer_mints_and_wallet_claims'", "'deposit_vault'", 'await burnBackToDepositKey('])
    ).toEqual([]);
    expect(arcSpec).toMatch(/const depositKey: PayoutKey = \{\s*key: \{ address: evmAddress,/);
    expect(arcSpec).toMatch(/burnBackToDepositKey\(\{[\s\S]*\bdepositKey,/);
  });
});

describe('the burn half the live iOS specs share', () => {
  it('names Arc endpoints by host', () => {
    expect(burnHalf).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(burnHalf).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
  });

  it('gates on the payout before the wallet confirmation', () => {
    expect(
      outOfOrder(burnHalf, [
        "'arc_state'",
        "'grant'",
        'await payoutLeg(step,',
        "'burn_via_send'",
        'await waitForPayout(',
        "'wallet_confirms_payout'"
      ])
    ).toEqual([]);
  });

  // R20: the payout refills the key the deposit spent, and the gate counts from the leg's read right before the burn.
  it('burns back to the deposit key and holds the wallet to the snapshot the payout gate counts from', () => {
    expect(between(burnHalf, 'settle_grant', 'burn_via_send')).toMatch(/takeKey: \(\) => ctx\.depositKey,/);
    expect(between(burnHalf, 'burn_via_send', 'burn_completed')).toMatch(/destAddress: key\.address,/);
    expect(between(burnHalf, 'burn_completed', 'burn_consumed')).toMatch(/before: snapshot\.balance\.toString\(\)/);
  });
});
