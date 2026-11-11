/** @jest-environment node */
import { chooseSwapCheckpoint, swapStepAttempted } from './mainnet-swap-artifacts.mjs';

const baseline = 42966766471;
const runs = [{ id: baseline + 2 }, { id: baseline + 1 }, { id: baseline }];
const artifact = (name: string, expired = false) => ({ name, expired });
const jobs = (name: string, conclusion = 'cancelled') => ({
  jobs: [{ steps: [{ name, status: 'completed', conclusion }] }]
});

describe('provider-scoped mainnet recovery discovery', () => {
  it('never substitutes a swap artifact or swap attempt for Epoch evidence', async () => {
    const selected = await chooseSwapCheckpoint(runs, async id => ({ artifacts: [
      artifact(`mainnet-${id === baseline + 2 ? 'swap' : 'epoch'}-final-${id}`)
    ] }), async () => jobs('Run mainnet swap forward'), baseline, 'epoch');
    expect(selected).toEqual({ runId: baseline + 1, name: `mainnet-epoch-final-${baseline + 1}`, bootstrap: false });
  });
  it('blocks a cancelled Epoch attempt without its own checkpoint even when swap state exists', async () => {
    await expect(chooseSwapCheckpoint(runs, async id => ({ artifacts: [artifact(`mainnet-swap-final-${id}`)] }),
      async () => jobs('Run mainnet epoch forward'), baseline, 'epoch')).rejects.toThrow(/missing/);
  });
  it('does not replace expired Epoch authorization with an older completed round trip', async () => {
    await expect(chooseSwapCheckpoint(runs, async id => ({ artifacts: [
      artifact(`mainnet-epoch-${id === baseline + 2 ? 'forward-authorized' : 'final'}-${id}`, id === baseline + 2)
    ] }), async () => jobs('Run mainnet epoch forward'), baseline, 'epoch')).rejects.toThrow(/expired/);
  });
  it('retains the existing 1Click authorization artifact names for NEAR recovery', async () => {
    const selected = await chooseSwapCheckpoint(runs, async id => ({ artifacts: [
      artifact(`mainnet-1click-execute-started-${id}`), artifact(`mainnet-1click-preflight-${id}`)
    ] }), async () => ({ jobs: [] }), baseline, 'near');
    expect(selected).toEqual({ runId: baseline + 2, name: `mainnet-1click-execute-started-${baseline + 2}`, bootstrap: false });
  });
  it('does not bootstrap past an uncheckpointed legacy funded 1Click stage', async () => {
    await expect(chooseSwapCheckpoint(runs, async () => ({ artifacts: [] }),
      async () => jobs('Run funded 1Click swap-out and swap-back acceptance'), baseline, 'near')).rejects.toThrow(/missing/);
  });
  it('classifies only the requested provider and includes its running reverse stage', () => {
    expect(swapStepAttempted(jobs('Run mainnet epoch forward'), 'forward', 'epoch')).toBe(true);
    expect(swapStepAttempted(jobs('Run mainnet swap forward'), 'forward', 'epoch')).toBe(false);
    expect(swapStepAttempted({ jobs: [{ steps: [{ name: 'Run mainnet near reverse', status: 'in_progress', conclusion: null }] }] },
      'reverse', 'near')).toBe(true);
  });
  it.each(['__proto__', 'constructor', '../swap', '1click'])('refuses an unrecognized provider %s before bootstrap', async provider => {
    await expect(chooseSwapCheckpoint([{ id: baseline }], async () => ({ artifacts: [] }),
      async () => ({ jobs: [] }), baseline, provider)).rejects.toThrow(/provider/i);
  });
});
