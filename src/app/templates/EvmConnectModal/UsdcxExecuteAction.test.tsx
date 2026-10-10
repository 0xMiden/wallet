import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { UsdcxExecuteAction } from './UsdcxExecuteAction';

const execute = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(',')}` : key)
  })
}));
jest.mock('./useCctpExecute', () => ({ useCctpExecute: () => execute }));
jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button data-testid="usdcx-execute-button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const BASE_SEPOLIA = 84532;
const LEG = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' };

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue(`0x${'9'.repeat(64)}`);
});

describe('UsdcxExecuteAction', () => {
  it('renders nothing for a direct xReserve deposit or a settled row', () => {
    const { container, rerender } = render(
      <UsdcxExecuteAction txId="row" sourceChainId={5042002} phase="delivering" cctp={LEG} />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="ready" cctp={LEG} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says it is waiting for Circle until the burn is attested', () => {
    render(
      <UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={{ sourceDomain: 6 }} />
    );
    expect(screen.getByTestId('usdcx-execute-waiting')).toHaveTextContent('usdcxCctpAwaitingAttestation:Arc Testnet');
  });

  it('says Circle is executing a forwarded burn and offers no button', () => {
    render(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ sourceDomain: 6, forwarded: true, forwardState: 'PENDING' }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-forwarding')).toHaveTextContent('usdcxForwardingPending:Arc Testnet');
    expect(screen.queryByTestId('usdcx-execute-button')).not.toBeInTheDocument();
  });

  it('offers the execute once attested and runs it for the row', async () => {
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);
    expect(screen.getByTestId('usdcx-execute-ready')).toHaveTextContent('usdcxExecuteNeeded:Arc Testnet');

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(execute).toHaveBeenCalledWith('row', BASE_SEPOLIA, LEG);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the failure and lets the user try again', async () => {
    execute.mockRejectedValueOnce(new Error('User rejected'));
    render(<UsdcxExecuteAction txId="row" sourceChainId={BASE_SEPOLIA} phase="delivering" cctp={LEG} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('usdcx-execute-button'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('User rejected');
    expect(screen.getByTestId('usdcx-execute-button')).not.toBeDisabled();
  });

  it('reports the executed transfer while Circle attests the deposit', () => {
    render(
      <UsdcxExecuteAction
        txId="row"
        sourceChainId={BASE_SEPOLIA}
        phase="delivering"
        cctp={{ ...LEG, executeTxHash: `0x${'9'.repeat(64)}` }}
      />
    );
    expect(screen.getByTestId('usdcx-execute-submitted')).toHaveTextContent('usdcxExecuteSubmitted:Arc Testnet');
  });
});
