import { reportUserVisibleError } from './user-visible-error';
import { UserErrorId } from './user-visible-error-contract';

export function alertUserError(id: UserErrorId, message: string): void {
  window.alert(message);
  reportUserVisibleError(id, 'browser_alert');
}
