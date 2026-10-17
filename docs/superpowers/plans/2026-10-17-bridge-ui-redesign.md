# Bridge interface redesign

Approved scope: implement screenshot-ready bridge-in and bridge-out route/network presentation using Send's current design system. Preserve existing execution, balance validation, fee reserves and credentials. Brian authorized PR publication after reviewing the implementation.

Design: existing page/fill/ink/muted surfaces, Nunito headings, Inter supporting text, green bridge-in and blue Send actions. Large left-aligned amount, readable source/destination detail rows, outlined route cards with labelled fee/ETA and selected check. A network summary opens the canonical accessible sheet.

1. Add regression tests for valid funding prerequisites and network picker selection.
2. Make Receive navigate directly to Bridge in; move connect inside a shared flow frame. Implement amount/source/destination using canonical components.
3. Redesign shared route cards for both directions and outbound destination selection; preserve execution behavior.
4. Run focused regression suites, types and i18n. Build simulator app and capture UI-only fixture screenshots. Fresh review before final handoff.

Overlap: Utkarsh draft #1505 adds chain families, validation and logos. This branch deliberately only edits presentation on current main and will need a small integration conflict resolution in NetworkField/NetworkLogo when combined.

Final scope: preserve the previous Receive entry layout, redesign bridge connection/amount/routes and shared branded network choices, remove retired Epoch USDC from new deposits, and make bridge-in progress full width. Send hides top home actions from amount onward, including the review handoff. The ranked provider comparison component is implemented with illustrative preview examples only; live quote integration is a follow-up. See [review captures](../../bridge-ui-review/README.md).
