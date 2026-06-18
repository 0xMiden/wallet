import React, { FC } from 'react';

import { PRIMARY_HEX } from 'utils/brand-colors';

import CircularProgress from '../CircularProgress';

type SpinnerProps = {
  color?: string;
};

const Spinner: FC<SpinnerProps> = ({ color = PRIMARY_HEX }) => {
  return <CircularProgress borderWeight={2} progress={40} circleColor={color} circleSize={24} spin={true} />;
};

export default Spinner;
