export const bigIntToString = (bigIntValue: bigint) => {
  const bytes: number[] = [];
  let tempBigInt = bigIntValue;

  while (tempBigInt > BigInt(0)) {
    const byteValue = Number(tempBigInt & BigInt(255));
    bytes.push(byteValue);
    tempBigInt = tempBigInt >> BigInt(8);
  }

  // Reverse the bytes so that the most significant byte is first again
  bytes.reverse();

  const decoder = new TextDecoder();
  const asciiString = decoder.decode(Uint8Array.from(bytes));
  return asciiString;
};

export const parseStringToBigIntArray = (input: string) => {
  const bigIntRegex = /([0-9]+)u128/g;
  const matches = input.match(bigIntRegex);

  if (!matches) {
    return [];
  }

  const bigInts = matches.map(match => BigInt(match.slice(0, -4)));
  return bigInts;
};

export const joinBigIntsToString = (bigInts: bigint[]) => {
  let result = '';

  for (let i = 0; i < bigInts.length; i++) {
    const chunkString = bigIntToString(bigInts[i]!);
    result += chunkString;
  }

  return result;
};
