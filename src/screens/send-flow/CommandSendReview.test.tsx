import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import {
  CommandFlowBackProvider,
  FlowPresentationProvider,
  useCommandFlowBack
} from 'components/flow/FlowPresentation';

import { CommandSendReview } from './CommandSendReview';

function BackControl() {
  const back = useCommandFlowBack()?.activeBack;
  return (
    <button type="button" onClick={back} disabled={!back}>
      Workbench Back
    </button>
  );
}

it('uses the review controller Back and removes its handler when review unmounts', () => {
  const onBack = jest.fn();
  function View() {
    const [review, setReview] = useState(true);
    return (
      <>
        <button onClick={() => setReview(false)}>Leave review</button>
        <BackControl />
        {review && (
          <CommandSendReview title="Review" onBack={onBack} footer={<button>Submit</button>}>
            <span>Reviewed amount</span>
          </CommandSendReview>
        )}
      </>
    );
  }
  render(
    <FlowPresentationProvider value="command">
      <CommandFlowBackProvider>
        <View />
      </CommandFlowBackProvider>
    </FlowPresentationProvider>
  );
  expect(screen.getByText('Reviewed amount')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Workbench Back' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Leave review' }));
  expect(screen.getByRole('button', { name: 'Workbench Back' })).toBeDisabled();
});
