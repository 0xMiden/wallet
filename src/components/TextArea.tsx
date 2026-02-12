import React, { useEffect, useRef } from 'react';

import classNames from 'clsx';

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const TextArea: React.FC<TextAreaProps> = ({ className, value, ...props }) => {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textAreaRef.current) {
      // We need to reset the height momentarily to get the correct scrollHeight for the textarea
      textAreaRef.current.style.height = '0px';
      const scrollHeight = textAreaRef.current.scrollHeight;

      // We then set the height directly, outside of the render loop
      // Trying to set this with state or a ref will product an incorrect value.
      textAreaRef.current.style.height = scrollHeight + 'px';
    }
  }, [textAreaRef, value]);

  return (
    <textarea
      ref={textAreaRef}
      value={value}
      {...props}
      className={classNames(
        'border rounded-[10px] border-grey-200 ',
        'transition duration-300 ease-in-out',
        'min-h-[48px] p-3',
        'resize-none overflow-hidden',
        'placeholder-grey-400 font-base text-base',
        'border border-grey-200 hover:border-grey-300',
        'hover:border-grey-300',
        'outline-none',
        'focus:border-black focus:ring-1 focus:ring-black',
        'active:border-black',
        className
      )}
    />
  );
};
