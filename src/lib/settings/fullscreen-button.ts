import { createPersistedSetting } from './persisted-setting';

const fullscreen = createPersistedSetting('show_fullscreen_button_setting', ['on', 'off'] as const, 'off');

export const useShowFullscreenButton = (): boolean => fullscreen.useValue() === 'on';

export const setShowFullscreenButton = (show: boolean): void => fullscreen.set(show ? 'on' : 'off');
