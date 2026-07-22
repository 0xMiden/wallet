import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AdvancedDetails, FOLD_THRESHOLD, FoldableField } from './AdvancedDetails';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it('hides children until toggled, then reveals them', () => {
  render(
    <AdvancedDetails>
      <div>secret-json</div>
    </AdvancedDetails>
  );
  expect(screen.queryByText('secret-json')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'advancedDetails' }));
  expect(screen.getByText('secret-json')).toBeInTheDocument();
});

describe('FoldableField', () => {
  it('renders a numeric value inline with no toggle', () => {
    render(<FoldableField label="importNotes" value={0} />);
    expect(screen.getByText('importNotes:')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a short string value inline (quoted) with no toggle', () => {
    render(<FoldableField label="recipient" value="0xabc" />);
    expect(screen.getByText('"0xabc"')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('collapses a long string to a truncated preview and expands it on click', () => {
    const long = 'a'.repeat(FOLD_THRESHOLD + 30);
    render(<FoldableField label="requestBytes" value={long} />);

    const preview = `"${'a'.repeat(FOLD_THRESHOLD)}…"`;
    // Collapsed: truncated preview shown, full value hidden.
    expect(screen.getByText(preview)).toBeInTheDocument();
    expect(screen.queryByText(`"${long}"`)).not.toBeInTheDocument();

    // Expand.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(`"${long}"`)).toBeInTheDocument();
    expect(screen.queryByText(preview)).not.toBeInTheDocument();

    // Collapse again.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(preview)).toBeInTheDocument();
  });
});
