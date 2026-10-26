type Listener<T extends any[] = any[]> = (...args: T) => void;

const makeEvent = <T extends any[] = any[]>() => {
  const listeners = new Set<Listener<T>>();
  return {
    addListener: (fn: Listener<T>) => listeners.add(fn),
    removeListener: (fn: Listener<T>) => listeners.delete(fn),
    emit: (...args: T) => listeners.forEach(fn => fn(...args))
  };
};

const runtimeId = 'test-runtime-id';
const onConnect = makeEvent<[any]>();

const storageData: Record<string, any> = {};
const storage = {
  local: {
    async get(keys: string[] | Record<string, unknown>) {
      if (Array.isArray(keys)) {
        return keys.reduce<Record<string, any>>((acc, key) => {
          acc[key] = storageData[key];
          return acc;
        }, {});
      }
      return { ...storageData };
    },
    async set(obj: Record<string, any>) {
      Object.assign(storageData, obj);
    }
  }
};

const makePort = (name?: string) => {
  const onMessage = makeEvent<[any, any]>();
  const onDisconnect = makeEvent<[]>();

  const port: any = {
    name,
    sender: { id: runtimeId },
    onMessage: {
      addListener: onMessage.addListener,
      removeListener: onMessage.removeListener
    },
    onDisconnect: {
      addListener: onDisconnect.addListener,
      removeListener: onDisconnect.removeListener
    },
    postMessage(msg: any) {
      if (port.peer) {
        port.peer.__emitMessage(msg);
      }
    },
    __emitMessage(msg: any) {
      onMessage.emit(msg, port);
    }
  };

  return port;
};

const onMessage = makeEvent<[any, any, (response?: any) => void]>();

const runtime = {
  id: runtimeId,
  onConnect: {
    addListener: onConnect.addListener,
    removeListener: onConnect.removeListener
  },
  onMessage: {
    addListener: onMessage.addListener,
    removeListener: onMessage.removeListener
  },
  onInstalled: makeEvent(),
  onUpdateAvailable: makeEvent(),
  sendMessage: jest.fn(),
  connect: (info?: any) => {
    const portA = makePort(info?.name);
    const portB = makePort(info?.name);
    (portA as any).peer = portB;
    (portB as any).peer = portA;
    onConnect.emit(portB);
    return portA;
  },
  getManifest: () => ({ manifest_version: 3 }),
  getPlatformInfo: async () => ({ os: 'mac' }),
  getURL: (path: string) => `chrome-extension://${runtimeId}/${path}`,
  reload: jest.fn()
};

const tabs = {
  create: jest.fn(),
  query: jest.fn().mockResolvedValue([]),
  remove: jest.fn()
};

const extension = {
  getViews: () => []
};

/**
 * Deliberately Chrome-shaped: the response carries **no `data_collection` key**.
 *
 * The telemetry consent gate (`isTelemetryEnabledAsync`) reads this to decide
 * whether the browser has a data-collection consent of its own — Firefox 140+
 * does, Chrome does not — and it tells the two apart by whether that key is
 * present at all. Omitting it here is what makes this fake browser a Chrome, so
 * every suite that is not specifically about Firefox keeps gating on the
 * wallet's own setting alone, exactly as it did before the gate existed.
 *
 * Leaving `permissions` off entirely is the one thing this must not do: the gate
 * fails closed when the API throws, so an absent namespace would silently stop
 * every telemetry test from sending and look like a broken driver rather than a
 * missing mock. A suite that needs Firefox's answer replaces this module — see
 * `src/lib/telemetry/browser-consent.test.ts`.
 */
const permissions = {
  getAll: jest.fn(async () => ({ permissions: ['storage'], origins: [] }))
};

const windows = {
  create: jest.fn(async (opts?: any) => ({ id: 1, ...opts })),
  remove: jest.fn()
};

export { runtime, tabs, extension, windows, storage, permissions };

export default {
  runtime,
  tabs,
  extension,
  windows,
  storage,
  permissions
};
