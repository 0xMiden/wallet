import { sameWalletAccountId } from '../sdk/helpers';

const stripAccountTag = (id: string): string => {
  const separator = id.indexOf('_');
  return separator === -1 ? id : id.slice(0, separator);
};

// Compares two AccountIds ignoring the optional note tag suffix (part after '_')
export const compareAccountIds = (id1: string, id2: string): boolean => {
  if (!id1 || !id2) {
    return false;
  }
  const base1 = stripAccountTag(id1);
  const base2 = stripAccountTag(id2);
  if (!base1 || !base2) {
    return false;
  }
  if (base1 === base2) {
    return true;
  }
  return sameWalletAccountId(id1, id2);
};
