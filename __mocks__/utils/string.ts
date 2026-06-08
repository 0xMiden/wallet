export const capitalizeFirstLetter = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const truncateAddress = (addr: string) => addr;
export const truncateHash = (hash: string, front = 7, back = 4) =>
  hash ? `${hash.slice(0, front)}…${hash.slice(-back)}` : '';
