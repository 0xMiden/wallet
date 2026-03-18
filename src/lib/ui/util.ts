import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const clearClipboard = () => {
  window.navigator.clipboard.writeText('');
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
