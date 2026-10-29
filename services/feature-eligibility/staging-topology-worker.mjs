export { default } from './staging-topology.mjs';
export { EligibilityGuard, CallerEligibilityGuard } from './worker.mjs';

export class TopologyControl {
  async fetch() {
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
