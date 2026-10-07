/**
 * Empties a text field the way a user deleting its text would, and leaves focus in it.
 *
 * React keeps the last value it rendered in a tracker behind a setter on the element itself.
 * Writing through the prototype's setter goes around that tracker, so the bubbling `input` event
 * reads as a real edit: a controlled field's `onChange` runs, a library's own change handler runs
 * (react-currency-input-field resets its state there), and an uncontrolled field holds the empty
 * value. A textarea takes its own prototype's setter; the input one throws on any other element.
 */
export function clearFieldValue(field: HTMLInputElement | HTMLTextAreaElement | null): void {
  if (!field) return;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, '');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
}
