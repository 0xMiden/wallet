import React, { useState } from 'react';

import classNames from 'clsx';

import { ReactComponent as EyeClosedBold } from '../icons/eye-closed-bold.svg';
import { ReactComponent as EyeOpenBold } from '../icons/eye-open-bold.svg';

const usePasswordToggle = (): [string, JSX.Element] => {
  const [visible, setVisibility] = useState(false);
  const iconStyle = { height: '24px', width: '24px' };

  const Icon = (
    <button
      type="button"
      tabIndex={1}
      className={classNames('absolute inset-y-0 right-3 text-heading-gray')}
      onClick={() => setVisibility(!visible)}
    >
      {visible ? <EyeClosedBold style={iconStyle} /> : <EyeOpenBold style={iconStyle} />}
    </button>
  );

  const inputType = visible ? 'text' : 'password';

  return [inputType, Icon];
};

export default usePasswordToggle;
