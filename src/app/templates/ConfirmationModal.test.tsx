import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import ConfirmationModal from './ConfirmationModal';

// `t(key)` is never `init()`-ed in the unit env; echo the key back so the
// button copy ('cancel' / 'ok') is directly assertable by translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The real `ModalWithTitle` pulls in `CustomModal` → `react-modal` +
// `useAppEnv` (constate provider) + native mobile hooks. ConfirmationModal only
// relies on it to render its children and to receive the forwarded
// `onRequestClose` + `...restProps`, so a lightweight stand-in keeps the test
// hermetic while letting us assert exactly which props were forwarded.
let modalProps: Record<string, unknown> | undefined;
jest.mock('app/templates/ModalWithTitle', () => ({
  __esModule: true,
  default: (props: { children?: React.ReactNode; [key: string]: unknown }) => {
    const { children, ...rest } = props;
    modalProps = rest;
    return (
      <div
        data-testid="modal-with-title"
        data-title={String(rest.title ?? '')}
        data-is-open={String(rest.isOpen ?? '')}
      >
        {children}
      </div>
    );
  }
}));

// `FormSecondaryButton` / `FormSubmitButton` wrap the framer-motion `Button` +
// analytics + tippy tooltip. ConfirmationModal only wires their `onClick`
// handlers (cancel → onRequestClose, ok → onConfirm), so plain buttons that
// forward `onClick`, `type`, `className` and children are sufficient and keep
// the test focused on ConfirmationModal's own logic.
jest.mock('app/atoms/FormSecondaryButton', () => ({
  __esModule: true,
  default: ({
    onClick,
    children,
    className
  }: {
    onClick?: () => void;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <button type="button" data-testid="cancel-button" className={className} onClick={onClick}>
      {children}
    </button>
  )
}));

jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({ onClick, children, type }: { onClick?: () => void; children?: React.ReactNode; type?: string }) => (
    <button data-testid="ok-button" data-type={type} onClick={onClick}>
      {children}
    </button>
  )
}));

beforeEach(() => {
  modalProps = undefined;
});

describe('ConfirmationModal', () => {
  it('renders children, the cancel and confirm buttons with echoed copy', () => {
    render(
      <ConfirmationModal onConfirm={jest.fn()} onRequestClose={jest.fn()}>
        <span data-testid="modal-body">Are you sure?</span>
      </ConfirmationModal>
    );

    // children are rendered inside the modal body wrapper.
    expect(screen.getByTestId('modal-body')).toHaveTextContent('Are you sure?');

    // Button copy comes through the echoing `t`.
    const cancel = screen.getByTestId('cancel-button');
    const ok = screen.getByTestId('ok-button');
    expect(cancel).toHaveTextContent('cancel');
    expect(ok).toHaveTextContent('ok');

    // The secondary (cancel) button keeps its right-margin class and the submit
    // button is forced to type="button" so it doesn't submit an outer form.
    expect(cancel).toHaveClass('mr-3');
    expect(ok).toHaveAttribute('data-type', 'button');
  });

  it('invokes onRequestClose when the cancel button is clicked', () => {
    const onRequestClose = jest.fn();
    const onConfirm = jest.fn();

    render(
      <ConfirmationModal onConfirm={onConfirm} onRequestClose={onRequestClose}>
        body
      </ConfirmationModal>
    );

    fireEvent.click(screen.getByTestId('cancel-button'));

    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('invokes onConfirm when the confirm (ok) button is clicked', () => {
    const onRequestClose = jest.fn();
    const onConfirm = jest.fn();

    render(
      <ConfirmationModal onConfirm={onConfirm} onRequestClose={onRequestClose}>
        body
      </ConfirmationModal>
    );

    fireEvent.click(screen.getByTestId('ok-button'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('forwards onRequestClose and the remaining props (title, isOpen, ...) to ModalWithTitle', () => {
    const onRequestClose = jest.fn();

    render(
      <ConfirmationModal
        onConfirm={jest.fn()}
        onRequestClose={onRequestClose}
        title="Confirm action"
        isOpen
        className="extra-class"
      >
        body
      </ConfirmationModal>
    );

    // restProps (title / isOpen / className) are spread onto ModalWithTitle...
    expect(modalProps).toBeDefined();
    expect(modalProps).toMatchObject({
      title: 'Confirm action',
      isOpen: true,
      className: 'extra-class'
    });

    // ...and onRequestClose is passed through explicitly (not consumed).
    expect(modalProps?.onRequestClose).toBe(onRequestClose);

    // The stand-in reflects the forwarded props in the DOM too.
    const modal = screen.getByTestId('modal-with-title');
    expect(modal).toHaveAttribute('data-title', 'Confirm action');
    expect(modal).toHaveAttribute('data-is-open', 'true');

    // onConfirm must NOT be forwarded to the modal (it's destructured out).
    expect(modalProps).not.toHaveProperty('onConfirm');
    expect(modalProps).not.toHaveProperty('onRequestClose', undefined);
  });
});
