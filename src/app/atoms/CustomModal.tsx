import React, { FC } from 'react';

import classNames from 'clsx';
import Modal from 'react-modal';

import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isExtension } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';

export type CustomModalProps = Modal.Props & Partial<PropsWithChildren>;

const CustomModal: FC<CustomModalProps> = props => {
  const { className, overlayClassName, isOpen, ...restProps } = props;

  useHideDappBubblesWhileOpen(!!isOpen);

  const rootElement = document.getElementById('root');

  if (!rootElement) {
    return null;
  }

  return (
    <Modal
      id={'custom-modal'}
      {...restProps}
      isOpen={isOpen}
      className={classNames('bg-surface-solid rounded z-80 shadow-2xl', className)}
      appElement={rootElement}
      closeTimeoutMS={isExtension() ? 0 : 200}
      overlayClassName={classNames(
        // TOP OF THE STACK, and interactive even under a drawer. This modal is
        // how `useConfirm()` asks "are you sure?", and both callers that matter
        // live INSIDE a settings drawer (delete a contact, disconnect a dApp).
        // The layer ladder is: drawers 50 < native navbar 60 < dApp confirm 70 <
        // this. At the old z-30 the drawer's own full-screen overlay painted on
        // top, so the dialog was invisible AND its buttons were unclickable —
        // neither action could be completed at all.
        //
        // `pointer-events-auto` is the second half of the same bug: vaul drawers
        // are modal Radix dialogs, and Radix sets `pointer-events: none` on
        // <body> while one is open. react-modal portals into <body>, so the
        // dialog inherits that and stays inert no matter how high it sits.
        'fixed inset-0 z-80 pointer-events-auto',
        'bg-pure-white/10 dark:bg-pure-black/50 backdrop-blur-xl backdrop-saturate-150',
        'flex items-center justify-center',
        'p-6',
        overlayClassName
      )}
      onAfterOpen={() => {
        document.body.classList.add('overscroll-y-none');
      }}
      onAfterClose={() => {
        document.body.classList.remove('overscroll-y-none');
      }}
    />
  );
};

export default CustomModal;
