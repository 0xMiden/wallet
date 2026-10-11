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
});
