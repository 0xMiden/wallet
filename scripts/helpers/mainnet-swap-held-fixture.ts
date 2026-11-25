import type { MainnetSwapCheckpoint } from '../../playwright/e2e/helpers/mainnet-swap-checkpoint';

/** The audited first recovery return whose 1732 WBTC base units cannot be sold: granted, never signed or sent. */
export function swapHeldFixture(): MainnetSwapCheckpoint {
  return {
    version: 1,
    network: 'mainnet',
    account: 'mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5_qr7qqq9wr6w',
    sourceRunId: '45634536470',
    authorizationRunId: '45640131363',
    phase: 'reverse-authorized',
    createdAt: '2026-11-25T14:34:45.131Z',
    pricedAt: '2026-11-25T14:34:35.000Z',
    updatedAt: '2026-11-25T15:04:54.860Z',
    offer: {
      faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24_qr7qqq9wr6w',
      hex: '0xe69e6ca6e39df1b10c1e5399399feb',
      symbol: 'USDCX',
      decimals: 6,
      balance: '16351553',
      usdMicros: '999452'
    },
    request: {
      faucetId: 'mm1aqcgf57r38kwe52lm2thp5vv3g4af6h4_qr7qqq9wr6w',
      hex: '0x3084d3c389ececd15fda9770d18c8a',
      symbol: 'WBTC',
      decimals: 8,
      balance: '0',
      usdMicros: '57952000000'
    },
    native: {
      faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24_qr7qqq9wr6w',
      hex: '0xe69e6ca6e39df1b10c1e5399399feb',
      symbol: 'USDCX',
      decimals: 6,
      balance: '16351553',
      usdMicros: '999452'
    },
    baseFee: '7',
    principal: '1000549',
    forwardMinimum: '1728',
    reverseMinimum: '996298',
    knownOrderIds: [],
    feeBudget: '1260',
    paidFees: '266',
    lossBudgetUsdMicros: '2000000',
    forwardRequestAuthority: {
      nonce: '1597d520-a4f4-493f-9553-fb0abe472aff',
      noteId: '0x6107cb77b403593c02d5abb41f04ce11ba53252acce61c0474ac62e14d69d920',
      sha256: 'bcd63e36d42e98a56d9e717b0ab88659d25bc4f5133d66f9322b0cc7c25cab9a',
      canonicalSha256: 'bcd63e36d42e98a56d9e717b0ab88659d25bc4f5133d66f9322b0cc7c25cab9a',
      orderId: '5890805803494796975',
      minimumReceive: '1731',
      expiresAt: 1795617575000
    },
    forwardOrderId: '5890805803494796975',
    forwardClaimAuthority: {
      nonce: '0b66040d-b1ae-4555-87c9-641994d5bf01',
      sha256: '04b16be011c8d7b514d97ac987f044e821eb5db8a6aba057ef7ab3f8a5e1c321',
      canonicalSha256: '77217954e4f9da532bc16cab89f8a47fd61cfe42dac431b8db6a4ba3e4a9b69a',
      requestCanonicalSha256: '04b16be011c8d7b514d97ac987f044e821eb5db8a6aba057ef7ab3f8a5e1c321',
      expiresAt: 1795617600925,
      noteId: '0x921a76733e8bb53b021da49d2e268bcf6c52e3492d01c51d1cc7d542b96a1245',
      amount: '1732'
    },
    forwardReceived: '1732',
    forwardRefunded: '0',
    returnAmount: '1732',
    returnBaseline: { offer: '15350738', request: '1732', native: '15350738' },
    recoveredRunId: '45640131363',
    recoveryReturnAuthorizedAt: '2026-11-25T15:04:54.860Z'
  };
}
