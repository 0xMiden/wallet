import React from 'react';

import { render, screen } from '@testing-library/react';

import { FlowPresentationProvider, useFlowPresentation } from './FlowPresentation';

function Probe() {
  return <output>{useFlowPresentation()}</output>;
}

it('defaults to compact, opting in only the provider subtree', () => {
  render(
    <>
      <Probe />
      <FlowPresentationProvider value="command">
        <Probe />
      </FlowPresentationProvider>
    </>
  );
  expect(screen.getAllByText('compact')).toHaveLength(1);
  expect(screen.getAllByText('command')).toHaveLength(1);
});
