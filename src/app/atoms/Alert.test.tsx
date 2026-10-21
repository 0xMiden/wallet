import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import Alert from './Alert';

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

// Mock react-i18next
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

// Mock SVG
jest.mock('app/icons/close.svg', () => ({
  ReactComponent: () => <svg data-testid="close-icon" />
}));

describe('Alert', () => {
  it('renders description', () => {
    render(<Alert description="Test description" />);

    expect(screen.getByText('Test description')).toBeInTheDocument();
  });

  it('renders title when provided', () => {
    render(<Alert description="Test" title="Test Title" />);

    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('does not render title when not provided', () => {
    const { container } = render(<Alert description="Test" />);

    expect(container.querySelector('h2')).not.toBeInTheDocument();
  });

  it('applies warn type styles by default', () => {
    const { container } = render(<Alert description="Test" />);
    const alert = container.firstChild;

    expect(alert).toHaveClass('bg-yellow-100');
    expect(alert).toHaveClass('text-yellow-700');
  });

  it('applies success type styles', () => {
    const { container } = render(<Alert description="Test" type="success" />);
    const alert = container.firstChild;

    expect(alert).toHaveClass('bg-green-100');
    expect(alert).toHaveClass('text-green-700');
  });

  it('applies error type styles', () => {
    const { container } = render(<Alert description="Test" type="error" />);
    const alert = container.firstChild;

    expect(alert).toHaveClass('bg-red-100');
    expect(alert).toHaveClass('text-red-700');
  });

  it('has alert role', () => {
    render(<Alert description="Test" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('auto focuses when autoFocus is true', () => {
    render(<Alert description="Test" autoFocus />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveFocus();
  });

  it('does not auto focus when autoFocus is false', () => {
    render(<Alert description="Test" />);

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveFocus();
  });

  it('renders close button when closable', () => {
    render(<Alert description="Test" closable />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByTestId('close-icon')).toBeInTheDocument();
  });

  it('does not render close button when not closable', () => {
    render(<Alert description="Test" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = jest.fn();
    render(<Alert description="Test" closable onClose={onClose} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies custom className', () => {
    const { container } = render(<Alert description="Test" className="custom-class" />);
    const alert = container.firstChild;

    expect(alert).toHaveClass('custom-class');
  });

  it('passes through additional props', () => {
    render(<Alert description="Test" data-testid="my-alert" />);

    expect(screen.getByTestId('my-alert')).toBeInTheDocument();
  });
});

describe('Alert user-visible error ownership', () => {
  const identity: { errorId: 'incorrectPassword' } = { errorId: 'incorrectPassword' };
  const noIdentity: { errorId: null } = { errorId: null };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports only the closed inline pair after the real error description dwells for 1000 ms', () => {
    render(<Alert {...identity} type="error" title="private title" description="private raw detail 17.25" />);
    expect(screen.getByRole('alert')).toHaveTextContent('private raw detail 17.25');
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1));

    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'inline']]);
    act(() => jest.advanceTimersByTime(5000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'inline']]);
  });

  it('cancels the legacy error episode when its description clears before dwell', () => {
    const { rerender } = render(<Alert {...identity} type="error" description="temporary detail" />);
    act(() => jest.advanceTimersByTime(999));

    rerender(<Alert {...identity} type="error" description="" />);
    act(() => jest.advanceTimersByTime(5000));

    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('cancels the legacy error episode when the atom unmounts before dwell', () => {
    const { unmount } = render(<Alert {...identity} type="error" description="temporary detail" />);
    act(() => jest.advanceTimersByTime(999));

    unmount();
    act(() => jest.advanceTimersByTime(5000));

    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each<['warn' | 'success']>([['warn'], ['success']])(
    'keeps a %s legacy Alert quiet even with an explicit error identity',
    type => {
      render(<Alert {...identity} type={type} description="nonerror detail" />);

      act(() => jest.advanceTimersByTime(5000));

      expect(reportUserVisibleError).not.toHaveBeenCalled();
    }
  );

  it('keeps a legacy error Alert without an identity quiet', () => {
    render(<Alert type="error" description="raw detail" />);

    act(() => jest.advanceTimersByTime(5000));

    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('keeps a legacy error Alert with an explicit null identity quiet', () => {
    render(<Alert {...noIdentity} type="error" description="raw detail" />);

    act(() => jest.advanceTimersByTime(5000));

    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each(['', null])('keeps an empty legacy error description %p quiet', description => {
    render(<Alert {...identity} type="error" description={description} />);

    act(() => jest.advanceTimersByTime(5000));

    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('retains one legacy error episode when raw text changes and the atom rerenders', () => {
    const { rerender } = render(<Alert {...identity} type="error" description="first raw detail" />);
    act(() => jest.advanceTimersByTime(500));
    rerender(<Alert {...identity} type="error" description="second raw detail" />);
    act(() => jest.advanceTimersByTime(500));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'inline']]);

    rerender(<Alert {...identity} type="error" description="third raw detail" />);
    act(() => jest.advanceTimersByTime(5000));

    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'inline']]);
  });

  it('starts a new legacy error episode after an empty description clears the previous one', () => {
    const { rerender } = render(<Alert {...identity} type="error" description="first raw detail" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'inline']]);

    rerender(<Alert {...identity} type="error" description="" />);
    act(() => jest.advanceTimersByTime(1000));
    rerender(<Alert {...identity} type="error" description="second raw detail" />);
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));

    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['incorrectPassword', 'inline'],
      ['incorrectPassword', 'inline']
    ]);
  });

  it('consumes the legacy error identity without forwarding it to the DOM', () => {
    render(<Alert {...identity} type="error" description="visible detail" data-testid="real-alert" />);

    expect(screen.getByTestId('real-alert')).toHaveTextContent('visible detail');
    expect(screen.getByTestId('real-alert')).not.toHaveAttribute('errorId');
  });
});
