// The game icon's unused NetworkChip dependency imports only Pill from the full UI barrel.
// Keep the real Pill while avoiding unrelated authenticated wallet services in this isolated harness.
export { Pill } from '../../src/components/ui/Pill';
