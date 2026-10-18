/**
 * @jest-environment node
 */
import { judgeCell, type FailureEvidence } from './dapp-cells';
import { KNOWN_BUGS, registryOf, type KnownBug } from './dapp-known-bugs';
import pinned from './dapp-pinned.json';

const bug = (id: string): KnownBug => {
  const found = KNOWN_BUGS.find(candidate => candidate.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const hard = (cellId: string, evidence: FailureEvidence, text = 'failure') => ({
  cellId,
  source: 'hard' as const,
  text,
  evidence
});
const soft = (cellId: string, evidence: FailureEvidence, text = 'preview-verified: declared') => ({
  cellId,
  source: 'soft' as const,
  text,
  evidence
});
// Phase-1 extension placements stay intact when mobile evidence extends an entry.
const ON_EXTENSION = [
  { axis: 'offchain', surface: 'extension' },
  { axis: 'guardian', surface: 'extension' }
];

const ON_MOBILE = [
  { axis: 'offchain', surface: 'ios' },
  { axis: 'guardian', surface: 'ios' },
  { axis: 'offchain', surface: 'android' },
  { axis: 'guardian', surface: 'android' }
];
const ON_ALL = [...ON_EXTENSION, ...ON_MOBILE];

describe('known-bug registry', () => {
  it('has unique ids, a tracking issue or pull request and at least one cell each', () => {
    expect(new Set(KNOWN_BUGS.map(entry => entry.id)).size).toBe(KNOWN_BUGS.length);
    for (const entry of KNOWN_BUGS) {
      expect(entry.tracking).toMatch(/^[\w.-]+\/[\w.-]+#\d+ /);
      expect(Object.keys(entry.cells)).not.toHaveLength(0);
    }
  });

  it('K1 matches a provider that moved while the adapter kept the old address', () => {
    expect(bug('K1').cells).toEqual({
      S7: ON_EXTENSION,
      M1: ON_ALL,
      'WP7-switch': ON_EXTENSION,
      'WP7-revoke': ON_EXTENSION
    });
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'a', previousAddress: 'a' }))).toBe(
      true
    );
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'b', previousAddress: 'a' }))).toBe(
      false
    );
  });

  it('K1 matches a React context left on the old account after a switch or a revoke, and nothing else', () => {
    expect(bug('K1').cells).toEqual(
      expect.objectContaining({ 'WP7-switch': ON_EXTENSION, 'WP7-revoke': ON_EXTENSION })
    );
    const stayed = { previousAddress: 'a', reactAddress: 'a', reactConnected: true };
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, providerAddress: 'b' }))).toBe(true);
    expect(bug('K1').signature(hard('WP7-revoke', { ...stayed, providerAddress: null }))).toBe(true);
    // The context followed, or the provider never moved: not K1.
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, reactAddress: 'b', providerAddress: 'b' }))).toBe(false);
    expect(
      bug('K1').signature(
        hard('WP7-revoke', { previousAddress: 'a', providerAddress: null, reactAddress: null, reactConnected: false })
      )
    ).toBe(false);
    expect(bug('K1').signature(hard('WP7-revoke', { ...stayed, reactConnected: false, providerAddress: null }))).toBe(
      false
    );
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, providerAddress: 'a' }))).toBe(false);
    // The adapter's fact alone does not explain a React cell.
    expect(
      bug('K1').signature(hard('WP7-switch', { previousAddress: 'a', providerAddress: 'b', adapterAddress: 'a' }))
    ).toBe(false);
  });

  it('judges W6 on the fixed consume of carried noteBytes, with K2 (#1413) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.W6 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K2');
  });

  it('judges S9 on the fixed locked-wallet prompt, with K5 (#1414) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.S9 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K5');
  });

  it('judges M7 on the origin gate, with K7 (#1416) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.M7 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K7');
  });

  it('K10 matches an N4 miss by the id an import returned, and no longer the consume by it (#1389)', () => {
    expect(bug('K10').tracking).toContain('0xMiden/wallet#1536');
    expect(bug('K10').cells).toEqual({ N4: ON_EXTENSION });
    const unresolved = {
      name: 'WalletTransactionError',
      message: 'INVALID_PARAMS: Error: Note 0x0e5a could not be resolved'
    };
    expect(bug('K10').signature(hard('N4', { returnedIdUnlisted: true }))).toBe(true);
    expect(bug('K10').signature(soft('N4', { returnedIdUnlisted: true }))).toBe(false);
    expect(bug('K10').signature(hard('N4', { returnedIdUnlisted: false }))).toBe(false);
    expect(bug('K10').signature(hard('N4', { popupOpened: false, dappError: unresolved }))).toBe(false);
  });

  it('K11 matches an undecodable custom request that opened a popup, and not a refusal or a deadline', () => {
    expect(bug('K11').cells).toEqual({ 'R3-customUndecodable': ON_ALL });
    expect(bug('K11').signature(hard('R3-customUndecodable', { popupOpened: true }))).toBe(true);
    expect(bug('K11').signature(soft('R3-customUndecodable', { popupOpened: true }))).toBe(false);
    const refused = { name: 'InvalidParamsMidenWalletError', message: 'INVALID_PARAMS: Error: unexpected end of file' };
    expect(bug('K11').signature(hard('R3-customUndecodable', { popupOpened: false, dappError: refused }))).toBe(false);
    expect(bug('K11').signature(hard('R3-customUndecodable', {}, 'CellDeadlineExceeded: dApp one raw'))).toBe(false);
  });

  it('K12 matches a WalletContext export that holds no state while useWallet() sees the connect', () => {
    expect(bug('K12').tracking).toContain('0xMiden/web-sdk#484');
    expect(bug('K12').cells).toEqual({ WP9: ON_EXTENSION });
    expect(bug('K12').signature(hard('WP9', { reactConnected: true, reactExportedConnected: null }))).toBe(true);
    expect(bug('K12').signature(hard('WP9', { reactConnected: true, reactExportedConnected: true }))).toBe(false);
    expect(bug('K12').signature(hard('WP9', { reactConnected: true, reactExportedConnected: false }))).toBe(false);
    expect(bug('K12').signature(hard('WP9', { reactConnected: false, reactExportedConnected: null }))).toBe(false);
    expect(bug('K12').signature(soft('WP9', { reactConnected: true, reactExportedConnected: null }))).toBe(false);
  });

  it('K13 matches the signer setup error MF3 settled on, and no other', () => {
    expect(bug('K13').tracking).toContain('0xMiden/web-sdk#400');
    expect((bug('K13').cells.MF3 ?? []).map(at => at.axis).sort()).toEqual(Object.keys(pinned.texts.MF3).sort());
    const texts = Object.values(pinned.texts.MF3);
    expect(texts.length > 0 && texts.every(({ error, reason }) => error.length > 0 && reason.length > 0)).toBe(true);
    expect(
      texts.map(({ error, reason }) =>
        bug('K13').signature(hard('MF3', { signerInitError: `${error} 0x01 ${reason}` }))
      )
    ).toEqual(texts.map(() => true));
    // As the testnet run settled it on both axes, where only the private account's id differed.
    const observed =
      'Error: failed to import public account: account 0x2c0814e4ff753ac154d7d0659362d3 is private and its details ' +
      'cannot be retrieved from the network';
    expect(bug('K13').signature(hard('MF3', { signerInitError: observed }))).toBe(true);
    expect(bug('K13').signature(hard('MF3', { signerInitError: 'Error: network unreachable' }))).toBe(false);
    // The same import failing for another reason is another bug.
    expect(
      bug('K13').signature(
        hard('MF3', { signerInitError: 'Error: failed to import public account: account 0x01 could not be fetched' })
      )
    ).toBe(false);
    expect(bug('K13').signature(hard('MF3', {}))).toBe(false);
    expect(bug('K13').signature(soft('MF3', { signerInitError: observed }))).toBe(false);
  });

  it('K14 matches a mobile conformance run failing on exactly the pinned createAccount gap, on the mobile surfaces only', () => {
    const gap = [...pinned.mobileConformanceGap];
    expect(bug('K14').tracking).toContain('0xMiden/wallet#1543');
    expect(bug('K14').cells).toEqual({ S11: ON_MOBILE });
    expect(bug('K14').signature(hard('S11', { conformanceFailed: gap }))).toBe(true);
    expect(bug('K14').signature(hard('S11', { conformanceFailed: [...gap, 'requestSend'] }))).toBe(false);
    expect(bug('K14').signature(hard('S11', { conformanceFailed: [] }))).toBe(false);
    expect(bug('K14').signature(hard('S11', {}))).toBe(false);
    expect(bug('K14').signature(soft('S11', { conformanceFailed: gap }))).toBe(false);
    const registry = registryOf(KNOWN_BUGS);
    expect(registry.bugsFor('S11', 'extension', 'offchain').map(entry => entry.id)).not.toContain('K14');
    expect(registry.bugsFor('S11', 'ios', 'guardian').map(entry => entry.id)).toContain('K14');
    expect(registry.bugsFor('S11', 'android', 'offchain').map(entry => entry.id)).toContain('K14');
  });

  it("K15 matches the mobile provider's plain Error with the expected text, by cause under the adapter and by name raw", () => {
    const k15 = bug('K15');
    const wrapped = (causeName: string, message = 'NOT_GRANTED') => ({
      name: 'WalletConnectionError',
      message,
      causeName,
      causeMessage: message
    });
    expect(k15.tracking).toContain('0xMiden/wallet#1542');
    expect(k15.cells).toEqual(
      Object.fromEntries(
        [
          'S3',
          'S6',
          'R1-send',
          'R1-custom',
          'R3-noteType',
          'R3-customPayload',
          'R7-connect',
          'R7-send',
          'R7-consume',
          'R7-custom'
        ].map(id => [id, ON_MOBILE])
      )
    );
    for (const cell of ['S3', 'R1-send', 'R1-custom', 'R7-connect', 'R7-send', 'R7-consume', 'R7-custom']) {
      expect(k15.signature(soft(cell, { dappError: wrapped('Error') }))).toBe(true);
      expect(k15.signature(soft(cell, { dappError: wrapped('NotGrantedMidenWalletError') }))).toBe(false);
    }
    expect(k15.signature(soft('S6', { dappError: { name: 'Error', message: 'NOT_GRANTED' } }))).toBe(true);
    expect(
      k15.signature(
        soft('R3-noteType', {
          dappError: { name: 'Error', message: 'INVALID_PARAMS: Error: noteType is required' }
        })
      )
    ).toBe(true);
    expect(
      k15.signature(
        soft('R3-customPayload', {
          dappError: {
            name: 'Error',
            message: 'INVALID_PARAMS: Error: INVALID_PARAMS: Invalid CustomTransaction payload'
          }
        })
      )
    ).toBe(true);
    expect(
      k15.signature(
        soft('R3-customUndecodable', { dappError: { name: 'Error', message: 'INVALID_PARAMS: Error: eof' } })
      )
    ).toBe(true);
    // Candidate signatures never place an entry: this run's undecodable request prompted instead of refusing.
    expect(k15.cells['R3-customUndecodable']).toBeUndefined();
    expect(
      k15.signature(soft('S6', { dappError: { name: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' } }))
    ).toBe(false);
    expect(k15.signature(soft('S6', {}))).toBe(false);
    expect(k15.signature(soft('W1', { dappError: { name: 'Error', message: 'NOT_GRANTED' } }))).toBe(false);
    expect(
      registryOf(KNOWN_BUGS)
        .bugsFor('S6', 'extension', 'offchain')
        .map(entry => entry.id)
    ).not.toContain('K15');
  });

  it('K15 leaves a hard failure or a wrong message as fail-new', () => {
    const dappError = { name: 'Error', message: 'NOT_GRANTED' };
    expect(bug('K15').signature(hard('S6', { dappError }))).toBe(false);
    expect(bug('K15').signature(soft('S6', { dappError: { ...dappError, message: 'Request timeout' } }))).toBe(false);
    const input = {
      cellId: 'S6',
      evidence: { dappError },
      registry: registryOf(KNOWN_BUGS)
    };
    const refusal = { check: 'refusal-class', detail: 'plain Error' };
    expect(judgeCell({ ...input, surface: 'ios', axis: 'guardian', softFailures: [refusal] }).verdict).toBe(
      'fail-known'
    );
    // A later row, session or timing assertion must stay new even when the refusal class is already known.
    expect(
      judgeCell({
        ...input,
        surface: 'ios',
        axis: 'guardian',
        softFailures: [refusal],
        hardError: new Error('session stayed connected')
      }).verdict
    ).toBe('fail-new');
    expect(
      judgeCell({
        ...input,
        surface: 'android',
        axis: 'offchain',
        softFailures: [refusal],
        evidence: { dappError: { ...dappError, message: 'Request timeout' } }
      }).verdict
    ).toBe('fail-new');
  });

  it('explains a cell only on the surface and axis an entry names', () => {
    const entry: KnownBug = {
      id: 'KT',
      title: 'test',
      tracking: 'none',
      cells: { M1: [{ axis: 'guardian', surface: 'extension' }] },
      signature: () => true
    };
    const registry = registryOf([entry]);
    expect(registry.bugsFor('M1', 'extension', 'guardian').map(bug => bug.id)).toEqual(['KT']);
    expect(registry.bugsFor('M1', 'ios', 'guardian')).toEqual([]);
    expect(registry.bugsFor('M1', 'android', 'guardian')).toEqual([]);
    expect(registry.bugsFor('M1', 'extension', 'offchain')).toEqual([]);
  });

  // Spec 3.8: an entry reaches iOS or Android only with the run that showed its signature there (Task 12's K14, K15
  // and any K1 or K11 extension each name theirs).
  const unproven = (bugs: readonly KnownBug[]): string[] =>
    bugs
      .filter(entry => Object.values(entry.cells).some(placements => placements.some(at => at.surface !== 'extension')))
      .filter(entry => !/^\d+$/.test(entry.mobileEvidenceRun ?? ''))
      .map(entry => entry.id);

  it('places an entry on a mobile surface only with the run that showed its signature there', () => {
    const mobile: KnownBug = {
      id: 'KM',
      title: 'test',
      tracking: 'none',
      cells: { S11: [{ axis: 'guardian', surface: 'ios' }] },
      signature: () => true
    };
    expect(unproven([mobile])).toEqual(['KM']);
    expect(unproven([{ ...mobile, mobileEvidenceRun: '18700000001' }])).toEqual([]);
    expect(unproven(KNOWN_BUGS)).toEqual([]);
    expect(
      KNOWN_BUGS.filter(entry => entry.mobileEvidenceRun !== undefined).map(entry => [
        entry.id,
        entry.mobileEvidenceRun
      ])
    ).toEqual([
      ['K1', '39090853726'],
      ['K11', '39090853726'],
      ['K14', '39090853726'],
      ['K15', '39090853726']
    ]);
  });
});
