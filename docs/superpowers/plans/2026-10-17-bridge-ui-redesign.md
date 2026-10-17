# Bridge interface redesign

Approved scope: implement screenshot-ready bridge-in and bridge-out route/network presentation using Send's current design system. Keep transactions, configuration, balance validation, fee reserves and credentials unchanged. Do not publish.

Design: existing page/fill/ink/muted surfaces, Nunito headings, Inter supporting text, orange bridge-in and blue Send actions. Large left-aligned amount, readable source/destination detail rows, outlined route cards with labelled fee/ETA and selected check. A network summary opens the canonical accessible sheet.

1. Add regression tests for valid funding prerequisites and network picker selection.
2. Make Receive navigate directly to Bridge in; move connect inside a shared flow frame. Implement amount/source/destination using canonical components.
3. Redesign shared route cards for both directions and outbound destination selection; preserve execution behavior.
4. Run focused regression suites, types and i18n. Build simulator app and capture UI-only fixture screenshots. Fresh review before final handoff.

Overlap: Utkarsh draft #1505 adds chain families, validation and logos. This branch deliberately only edits presentation on current main and will need a small integration conflict resolution in NetworkField/NetworkLogo when combined.
