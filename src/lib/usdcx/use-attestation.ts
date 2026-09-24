import { useEffect, useState } from 'react';

import { isHash } from 'viem';

import { fetchXReserveAttestations, findAttestationForDomain } from './attestation';
import { USDCX_REMOTE_DOMAIN } from './constant';

export const ATTESTATION_POLL_MS = 12_000;

/** Attestation confirms the source deposit, independently of Miden note delivery. */
export function useUsdcxAttestation(txHash: string | undefined, active: boolean): boolean {
  const [attestedHash, setAttestedHash] = useState<string>();

  useEffect(() => {
    if (!active || !txHash || !isHash(txHash) || attestedHash === txHash) return;

    let cancelled = false;
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const attestations = await fetchXReserveAttestations(txHash);
        if (!cancelled && findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN)) {
          setAttestedHash(txHash);
          clearInterval(timer);
        }
      } catch (error) {
        if (!cancelled) console.error('[usdcx] Attestation poll failed', error);
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void poll(), ATTESTATION_POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, attestedHash, txHash]);

  return txHash !== undefined && attestedHash === txHash;
}
