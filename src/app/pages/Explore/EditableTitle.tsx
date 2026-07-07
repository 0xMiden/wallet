import React, { FC, useCallback } from 'react';

import classNames from 'clsx';

import Name from 'app/atoms/Name';
import { ReactComponent as EditIcon } from 'app/icons/edit.svg';
import { Button, ButtonVariant } from 'components/Button';
import { useAccount } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

import { EditableTitleSelectors } from './EditableTitle.selectors';

const EditableTitle: FC = () => {
  const account = useAccount();

  const handleEditClick = useCallback(() => {
    navigate('/edit-name');
  }, []);

  return (
    <div className="relative flex items-center pt-4">
      <>
        <Name
          className={classNames('mb-2 pl-4', 'font-normal text-black')}
          style={{ maxWidth: '24rem', fontSize: '12px', lineHeight: '16px' }}
        >
          {account.name}
        </Name>
        <Button
          variant={ButtonVariant.Ghost}
          className={classNames(
            'h-auto w-auto max-w-none p-1 ml-1 mb-2 border-0',
            'rounded overflow-hidden',
            'text-black text-sm',
            'opacity-75 hover:opacity-100 focus:opacity-100'
          )}
          onClick={handleEditClick}
          data-testid={EditableTitleSelectors.EditButton}
        >
          <EditIcon className={classNames('h-5 w-auto stroke-2')} />
        </Button>
      </>
    </div>
  );
};

export default EditableTitle;
