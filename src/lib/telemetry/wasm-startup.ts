/**
 * What a crash report adds when the SDK's WebAssembly traps while starting, as fixed values only.
 *
 * The trap is the first allocation of a fresh shared memory failing to grow (BREAD-WALLET-1). Whether any new shared
 * memory can still grow, and how many of the extension's documents hold an instance, tell the wallet's own instances
 * exhausting the process apart from a platform limit and from a device out of memory. Import-free, so every realm
 * that starts the SDK can load it.
 */
export const SHARED_MEMORY_PROBES = ['grew', 'refused', 'unavailable'] as const;
export const EXTENSION_VIEW_COUNTS = ['1', '2-3', '4+', 'unavailable'] as const;

export type WasmStartupEvidence = {
  sharedMemoryProbe?: (typeof SHARED_MEMORY_PROBES)[number];
  extensionViews?: (typeof EXTENSION_VIEW_COUNTS)[number];
};

// The SDK keeps its failed start, so every later caller catches the same error object.
const probed = new WeakSet<object>();

function probeSharedMemory(): (typeof SHARED_MEMORY_PROBES)[number] {
  if (globalThis.crossOriginIsolated !== true) return 'unavailable';
  try {
    // The shape the SDK's glue builds, at its maximum.
    new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }).grow(1);
    return 'grew';
  } catch {
    return 'refused';
  }
}

function countExtensionViews(): (typeof EXTENSION_VIEW_COUNTS)[number] {
  try {
    if (typeof chrome === 'undefined' || typeof chrome.extension?.getViews !== 'function') return 'unavailable';
    // Every page of this extension, the offscreen document included (Chrome 153).
    const count = chrome.extension.getViews().length;
    if (count >= 4) return '4+';
    if (count >= 2) return '2-3';
    return count === 1 ? '1' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function wasmStartupEvidence(error: unknown): WasmStartupEvidence {
  try {
    if (!(error instanceof WebAssembly.RuntimeError) || probed.has(error)) return {};
    probed.add(error);
    return { sharedMemoryProbe: probeSharedMemory(), extensionViews: countExtensionViews() };
  } catch {
    return {};
  }
}
