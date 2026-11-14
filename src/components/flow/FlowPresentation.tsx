import React, { createContext, useContext } from 'react';

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
