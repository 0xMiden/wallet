import { sameWalletAccountId } from '../sdk/helpers';

// Compares two AccountIds ignoring the optional note tag suffix (part after '_')
export const compareAccountIds = (id1: string, id2: string): boolean => {
  if (!id1 || !id2) {
    return false;
  }
  return sameWalletAccountId(id1, id2);
};
