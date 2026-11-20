import React, { createContext, useContext, useLayoutEffect, useState } from 'react';

export type FlowPresentation = 'compact' | 'command';

const Context = createContext<FlowPresentation>('compact');

export function FlowPresentationProvider({
  value,
  children
}: {
  value: FlowPresentation;
  children: React.ReactNode;
}): React.ReactElement {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useFlowPresentation(): FlowPresentation {
  return useContext(Context);
}

type FlowBackState = {
  activeBack?: () => void;
  setActiveBack: React.Dispatch<React.SetStateAction<(() => void) | undefined>>;
};

const CommandFlowBackContext = createContext<FlowBackState | null>(null);

export function CommandFlowBackProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [activeBack, setActiveBack] = useState<() => void>();
  return (
    <CommandFlowBackContext.Provider value={{ activeBack, setActiveBack }}>{children}</CommandFlowBackContext.Provider>
  );
}

export const useCommandFlowBack = () => useContext(CommandFlowBackContext);

export function useRegisterCommandFlowBack(onBack?: () => void): void {
  const command = useFlowPresentation() === 'command';
  const setActiveBack = useCommandFlowBack()?.setActiveBack;
  useLayoutEffect(() => {
    if (!command || !onBack || !setActiveBack) return;
    setActiveBack(() => onBack);
    return () => setActiveBack(current => (current === onBack ? undefined : current));
  }, [command, onBack, setActiveBack]);
}
