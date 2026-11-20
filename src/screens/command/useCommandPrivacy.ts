import { useStorage } from 'lib/miden/front/storage';

export function useCommandPrivacy() {
  return useStorage<boolean>('command_hide_balances', false);
}
