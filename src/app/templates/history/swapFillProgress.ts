/** A ratio of requested-token base units; token decimals cancel before division. */
export const swapFillProgress = (
  filled: bigint | undefined,
  total: bigint | undefined
): { value: number; text: string } | undefined => {
  if (filled === undefined || total === undefined || total <= 0n || filled < 0n) return undefined;
  if (filled >= total) return { value: 100, text: '100' };
  const value = Number((filled * 1000n) / total) / 10;
  // Round down so a partial fill never reads 100%, and name the display limit
  // rather than claiming that a smaller execution filled exactly 0.1%.
  return { value, text: filled > 0n && value === 0 ? '<0.1' : String(value) };
};
