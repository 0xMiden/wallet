import React, { FC, HTMLAttributes } from 'react';

import randomColor from 'randomcolor';
import seedrandom from 'seedrandom';

import { ReactComponent as AnimalIcons } from 'app/icons/animals.svg';

type AnimalIdenticonProps = HTMLAttributes<HTMLDivElement> & {
  publicKey: string;
  size?: number;
};

const NUM_ANIMALS = 19;

const indexToMinY = [
  -20, 580, 1200, 1850, 2490, 3110, 3780, 4450, 5050, 5650, 6250, 6800, 7350, 7950, 8550, 9150, 9700, 10300, 10960
];

// There isn't a consistent formula for the given file
const indexToViewBox = (index: number): string => {
  if (index < 0 || index > 19) {
    throw new Error('Out of bounds');
  }
  const minY = indexToMinY[index];
  return `0 ${minY} 630 610`;
};

const getAnimalIndex = (publicKey: string): number => {
  const seededRng = seedrandom(publicKey);
  const random = seededRng();
  return Math.floor(random * NUM_ANIMALS);
};

const AnimalIdenticon: FC<AnimalIdenticonProps> = ({ publicKey, size = 100, className }) => {
  const color = randomColor({ seed: publicKey });
  const animalIndex = getAnimalIndex(publicKey);
  const viewBox = indexToViewBox(animalIndex);
  return (
    <AnimalIcons
      className={'rounded-full ' + className}
      width={size}
      height={size}
      viewBox={viewBox}
      style={{
        backgroundColor: color
      }}
    />
  );
};

export default AnimalIdenticon;
