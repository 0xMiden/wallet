import React, { FC, useCallback } from 'react';

import classNames from 'clsx';

import { Button } from 'app/atoms/Button';
import Name from 'app/atoms/Name';
import { ReactComponent as EditIcon } from 'app/icons/edit.svg';
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
          className={classNames(
            'px-1 py-1 ml-1 mb-2',
            'rounded overflow-hidden',
            'text-black text-sm',
            'transition ease-in-out duration-200',
            'hover:bg-black hover:bg-opacity/5',
            'opacity-75 hover:opacity-100 focus:opacity-100'
          )}
          onClick={handleEditClick}
          testID={EditableTitleSelectors.EditButton}
        >
          <EditIcon className={classNames('h-5 w-auto stroke-2')} />
        </Button>
      </>
    </div>
  );
};

export default EditableTitle;
