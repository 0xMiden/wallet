import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import AlertModal from './AlertModal';
import { ModalWithTitleProps } from './ModalWithTitle';

// ---------------------------------------------------------------------------
// Mocks.
//
// AlertModal.tsx is a thin presentational wrapper: it destructures
// `onRequestClose` / `children` out of its props, forwards the rest to
// `ModalWithTitle`, renders the children, and wires an "OK" submit button back
// to `onRequestClose`. We stub every collaborator so the only code executed
// (and measured) is AlertModal.tsx itself.
//   - `react-i18next`: identity translator so the button label asserts against
//     the raw translation key (`ok`).
//   - `ModalWithTitle`: capture the props AlertModal forwards (so we can assert
//     `onRequestClose` + any `...restProps` such as `title` / `isOpen` are
//     passed through) while rendering its children into the DOM — this avoids
//     pulling in the real react-modal / CustomModal / useAppEnv chain.
//   - `FormSubmitButton`: a plain <button> that forwards `type`, `className`,
//     `onClick` and children so the OK-button branch (including the
//     `onRequestClose` wiring) is assertable without framer-motion / haptics.
// ---------------------------------------------------------------------------

// i18n: echo the key back so text assertions read the raw translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Capture the props ModalWithTitle receives; render children so downstream
// assertions (OK button, body content) work.
const modalPropsSpy = jest.fn();
jest.mock('app/templates/ModalWithTitle', () => ({
  __esModule: true,
  default: (props: ModalWithTitleProps) => {
    modalPropsSpy(props);
    const { children, ...rest } = props;
    return (
      <div data-testid="modal-with-title" data-props={JSON.stringify(Object.keys(rest))}>
        {children}
      </div>
    );
  }
}));

// FormSubmitButton stub: forward the props AlertModal sets so we can assert them
// and drive the onClick handler by clicking.
jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({
    children,
    onClick,
    type,
    className
  }: {
    children?: React.ReactNode;
    onClick?: (e: unknown) => void;
    type?: string;
    className?: string;
  }) => (
    <button data-testid="ok-button" type={type as 'button'} className={className} onClick={onClick}>
      {children}
    </button>
  )
}));

beforeEach(() => {
  modalPropsSpy.mockClear();
});

describe('AlertModal', () => {
  it('renders children inside the modal body and an OK submit button', () => {
    render(
      <AlertModal onRequestClose={jest.fn()} isOpen>
        <span>alert body content</span>
      </AlertModal>
    );

    // Children are rendered into the modal body.
    expect(screen.getByText('alert body content')).toBeInTheDocument();

    // The OK button renders the translated `ok` key and is a plain button
    // (type="button") so it never submits an enclosing form.
    const okButton = screen.getByTestId('ok-button');
    expect(okButton).toHaveTextContent('ok');
    expect(okButton).toHaveAttribute('type', 'button');
    expect(okButton).toHaveClass('w-full', 'justify-center');
  });

  it('forwards onRequestClose and every remaining prop to ModalWithTitle', () => {
    const onRequestClose = jest.fn();

    render(
      <AlertModal onRequestClose={onRequestClose} title="Heads up" isOpen>
        content
      </AlertModal>
    );

    expect(modalPropsSpy).toHaveBeenCalledTimes(1);
    const forwarded = modalPropsSpy.mock.calls[0][0] as ModalWithTitleProps;

    // `onRequestClose` is passed through explicitly.
    expect(forwarded.onRequestClose).toBe(onRequestClose);
    // `...restProps` carries the remaining props (title / isOpen) unchanged.
    expect(forwarded.title).toBe('Heads up');
    expect(forwarded.isOpen).toBe(true);
    // ModalWithTitle receives AlertModal's own wrapping layout as its
    // `children` (the flex column that holds the body + OK button), not the
    // raw `content` node — that is nested one level deeper inside the wrapper.
    expect(forwarded.children).toBeTruthy();
  });

  it('invokes onRequestClose when the OK button is clicked', () => {
    const onRequestClose = jest.fn();

    render(
      <AlertModal onRequestClose={onRequestClose} isOpen>
        body
      </AlertModal>
    );

    fireEvent.click(screen.getByTestId('ok-button'));

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('does not throw when clicked with no onRequestClose handler provided', () => {
    // `onRequestClose` is optional on ModalWithTitleProps → the OK button's
    // onClick is `undefined`; clicking must be a no-op, not a crash.
    render(<AlertModal isOpen>body without handler</AlertModal>);

    const okButton = screen.getByTestId('ok-button');
    expect(() => fireEvent.click(okButton)).not.toThrow();

    // The undefined handler is still forwarded to ModalWithTitle unchanged.
    const forwarded = modalPropsSpy.mock.calls[0][0] as ModalWithTitleProps;
    expect(forwarded.onRequestClose).toBeUndefined();
  });
});
