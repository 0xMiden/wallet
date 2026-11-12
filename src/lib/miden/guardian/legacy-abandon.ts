import { GuardianHttpError, RequestAuthPayload } from '@openzeppelin/guardian-client';

import type { WalletSigner } from './signer';

// The pause before re-signing a request that lost the Guardian's timestamp race, the client's own.
const REPLAY_RETRY_DELAY_MS = 50;

/**
 * Ask the Guardian at `endpoint` to abandon the candidate at `nonce` with the nonce-only body `{ account_id, nonce }`,
 * signed by `signer` over exactly that body. Every Guardian from 0.18 on takes this body. A 0.18 Guardian verifies the
 * signature over a body it rebuilds without `proposal_id`, so it refuses the proposal-bound abandon the 0.19 client
 * signs. A 0.19 Guardian names the abandoned delta's commitment, which tells that delta from a later one at the same
 * nonce; a 0.18 one names none.
 *
 * A refusal throws `GuardianHttpError`. `authentication_replay` (the timestamp was not past the last one the Guardian
 * saw from this signer) is retried once, with a later timestamp; a second replay throws.
 */
export async function abandonCandidateByNonce(
  endpoint: string,
  signer: Pick<WalletSigner, 'publicKey' | 'signRequest'>,
  accountIdHex: string,
  nonce: number
): Promise<{ commitment?: string }> {
  const body = { account_id: accountIdHex, nonce };
  const payload = RequestAuthPayload.fromRequest(body);
  const post = async (timestamp: number): Promise<Response> => {
    const signature = await signer.signRequest(accountIdHex, timestamp, payload);
    const response = await fetch(`${endpoint}/delta/candidate/abandon`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pubkey': signer.publicKey,
        'x-signature': signature,
        'x-timestamp': timestamp.toString()
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new GuardianHttpError(response.status, response.statusText, text, response.headers.get('Retry-After'));
    }
    return response;
  };

  const firstTimestamp = Date.now();
  let response: Response;
  try {
    response = await post(firstTimestamp);
  } catch (error) {
    if (!(error instanceof GuardianHttpError) || error.code !== 'authentication_replay') throw error;
    await new Promise(resolve => setTimeout(resolve, REPLAY_RETRY_DELAY_MS));
    response = await post(Math.max(Date.now(), firstTimestamp + 1));
  }
  const commitment = answeredCommitment(await response.json());
  return commitment === undefined ? {} : { commitment };
}

const answeredCommitment = (answer: unknown): string | undefined =>
  typeof answer === 'object' && answer !== null && 'commitment' in answer && typeof answer.commitment === 'string'
    ? answer.commitment
    : undefined;
