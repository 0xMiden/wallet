// Jest's JSON writer cannot serialize BigInt values retained in failed matcher details.
module.exports = results =>
  JSON.parse(
    JSON.stringify(results, (_key, value) =>
      typeof value === 'bigint' ? { type: 'bigint', decimal: value.toString() } : value
    )
  );
