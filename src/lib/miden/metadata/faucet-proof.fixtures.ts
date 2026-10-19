// Pinned miden-standards 0.17.1 slot layout; raw limbs are independent of the reader.
export const FAUCET_PROOF_WORDS: Readonly<Record<string, readonly [bigint, bigint, bigint, bigint]>> = {
  'miden::standards::faucets::fungible::token_config': [1000n, 1000000n, 8n, 8765514n],
  'miden::standards::faucets::token_name_0': [0x20666f6f72500bn, 0x6e656b6f54n, 0n, 0n],
  'miden::standards::faucets::token_name_1': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_0': [
    0x61646174654d1an,
    0x68746977206174n,
    0x6e6f6e2074756fn,
    0x70616d206563n
  ],
  'miden::standards::faucets::token_description_1': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_2': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_3': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_4': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_5': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::token_description_6': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_0': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_1': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_2': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_3': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_4': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_5': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::logo_uri_6': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_0': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_1': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_2': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_3': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_4': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_5': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::external_link_6': [0n, 0n, 0n, 0n],
  'miden::standards::faucets::mutability_config': [0n, 0n, 0n, 0n]
};

export type FaucetProofWords = typeof FAUCET_PROOF_WORDS;

// Only transposes independently supplied raw bytes; it does not encode strings or symbols.
export function rawFieldWords(field: string, bytes: readonly number[]): FaucetProofWords {
  const count = field === 'token_name' ? 2 : 7;
  return Object.fromEntries(
    Array.from({ length: count }, (_, wordIndex) => [
      `miden::standards::faucets::${field}_${wordIndex}`,
      Array.from({ length: 4 }, (_, feltIndex) => {
        let limb = 0n;
        for (let index = 0; index < 7; index++) {
          limb |= BigInt(bytes[(wordIndex * 4 + feltIndex) * 7 + index] ?? 0) << BigInt(index * 8);
        }
        return limb;
      }) as [bigint, bigint, bigint, bigint]
    ])
  );
}

export const TEST_NAME_BYTES = [10, 84, 101, 115, 116, 32, 84, 111, 107, 101, 110];
export const TEST_DESCRIPTION_BYTES = [
  17, 65, 32, 116, 111, 107, 101, 110, 32, 102, 111, 114, 32, 116, 101, 115, 116, 115
];
export const MULTILINGUAL_NAME_BYTES = [32, ...Array(10).fill([0xe7, 0x8c, 0xab]).flat(), 0xc3, 0xa9];
