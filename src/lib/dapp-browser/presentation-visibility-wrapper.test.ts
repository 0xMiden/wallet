import { DappWebViewInstance, dappWebViewManager } from '../../../packages/dapp-browser/dist/esm/multi-instance';

const mockVisible = jest.fn(async (_options: unknown) => {});
const mockRect = jest.fn(async (_options: unknown) => {});
const mockMorph = jest.fn(async (_options: unknown) => ({ accepted: true }));
const mockTarget = jest.fn(async (_options: unknown) => {});
jest.mock('../../../packages/dapp-browser/dist/esm/index.js', () => ({
  InAppBrowser: {
    setVisible: (options: unknown) => mockVisible(options),
    updateDimensions: (options: unknown) => mockRect(options),
    morph: (options: unknown) => mockMorph(options),
    setMorphTarget: (options: unknown) => mockTarget(options),
    close: async () => {}
  }
}));

const CARD = { x: 282, y: 650, width: 104, height: 132, cornerRadius: 16 };

afterEach(() => jest.clearAllMocks());

it('binds each visibility command to its immutable lifetime and increasing sequence', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  const acknowledge = instance.setVisible as (visible: boolean, revision?: number) => Promise<void>;
  await acknowledge.call(instance, true, 3);
  await acknowledge.call(instance, false);
  await acknowledge.call(instance, true, 3);
  expect(mockVisible.mock.calls.map(([options]) => options)).toEqual([
    { id: 'session', visible: true, managedHostCloseToken: 'lifetime', visibilitySequence: 1, policyRevision: 3 },
    { id: 'session', visible: false, managedHostCloseToken: 'lifetime', visibilitySequence: 2 },
    { id: 'session', visible: true, managedHostCloseToken: 'lifetime', visibilitySequence: 3, policyRevision: 3 }
  ]);
});

it('does not let a closed wrapper dispatch into a replacement lifetime', async () => {
  const instance = new DappWebViewInstance('session', 'outgoing');
  await instance.close();
  await instance.setVisible(true);
  await instance.setRect({ x: 0, y: 0, width: 100, height: 100 });
  expect(mockVisible).not.toHaveBeenCalled();
  expect(mockRect).not.toHaveBeenCalled();
});

it('binds bounds to the same managed lifetime and preserves the legacy signature', async () => {
  const rect = { x: 0, y: 10, width: 100, height: 90 };
  await new DappWebViewInstance('managed', 'lifetime').setRect(rect);
  await new DappWebViewInstance('legacy').setVisible(true);
  expect(mockRect).toHaveBeenCalledWith({ id: 'managed', managedHostCloseToken: 'lifetime', ...rect });
  expect(mockVisible).toHaveBeenCalledWith({ id: 'legacy', visible: true });
});

it('exposes the latest issued visibility sequence without a writable getter', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  expect(instance.currentVisibilitySequence).toBe(0);
  await instance.setVisible(true, 3);
  expect(instance.currentVisibilitySequence).toBe(1);
  await instance.setVisible(false);
  expect(instance.currentVisibilitySequence).toBe(2);
  expect(
    Object.getOwnPropertyDescriptor(DappWebViewInstance.prototype, 'currentVisibilitySequence')?.set
  ).toBeUndefined();
});

it('binds a morph to the lifetime and the sequence it shares with setVisible', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  await instance.setVisible(true, 3);
  await expect(
    instance.morph({ to: 'collapsed', card: CARD, morphId: 'm1', velocity: { x: 0, y: -900 } })
  ).resolves.toEqual({ accepted: true });
  await new DappWebViewInstance('legacy').morph({ to: 'expanded', card: null, morphId: 'm2' });
  expect(mockMorph.mock.calls.map(([options]) => options)).toStrictEqual([
    {
      id: 'session',
      managedHostCloseToken: 'lifetime',
      visibilitySequence: 2,
      to: 'collapsed',
      card: CARD,
      morphId: 'm1',
      velocity: { x: 0, y: -900 }
    },
    { id: 'legacy', to: 'expanded', card: null, morphId: 'm2' }
  ]);
  expect(instance.currentVisibilitySequence).toBe(2);
});

it('sends a policy revision only with an expand', async () => {
  const instance = new DappWebViewInstance('session', 'lifetime');
  await instance.morph({ to: 'collapsed', card: CARD, morphId: 'm1', policyRevision: 4 });
  await instance.morph({ to: 'expanded', card: CARD, morphId: 'm2', policyRevision: 4 });
  await instance.morph({ to: 'expanded', card: CARD, morphId: 'm3' });
  const managed = (visibilitySequence: number) => ({
    id: 'session',
    managedHostCloseToken: 'lifetime',
    visibilitySequence
  });
  expect(mockMorph.mock.calls.map(([options]) => options)).toStrictEqual([
    { ...managed(1), to: 'collapsed', card: CARD, morphId: 'm1' },
    { ...managed(2), to: 'expanded', card: CARD, morphId: 'm2', policyRevision: 4 },
    { ...managed(3), to: 'expanded', card: CARD, morphId: 'm3' }
  ]);
});

it('answers a morph on a closed wrapper as not accepted without a native call', async () => {
  const closed = new DappWebViewInstance('session', 'lifetime');
  await closed.close();
  const closing = new DappWebViewInstance('other', 'lifetime');
  const pending = closing.close();
  await expect(closed.morph({ to: 'expanded', card: CARD, morphId: 'm1' })).resolves.toEqual({ accepted: false });
  await expect(closing.morph({ to: 'collapsed', card: CARD, morphId: 'm2' })).resolves.toEqual({ accepted: false });
  await pending;
  expect(mockMorph).not.toHaveBeenCalled();
  expect(closed.currentVisibilitySequence).toBe(0);
  expect(closing.currentVisibilitySequence).toBe(0);
});

it('publishes the landing card through the manager', async () => {
  await dappWebViewManager.setMorphTarget(CARD);
  await dappWebViewManager.setMorphTarget(null);
  expect(mockTarget.mock.calls.map(([options]) => options)).toStrictEqual([{ card: CARD }, { card: null }]);
});
