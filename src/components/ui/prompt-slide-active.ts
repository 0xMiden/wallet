import { createContext, useContext } from 'react';

export const PromptSlideActiveContext = createContext(true);

export function usePromptSlideActive(): boolean {
  return useContext(PromptSlideActiveContext);
}
