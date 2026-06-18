import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

import { isMobile } from 'lib/platform';
import { isHapticFeedbackEnabled } from 'lib/settings/helpers';

import {
  hapticLight,
  hapticMedium,
  hapticHeavy,
  hapticSuccess,
  hapticWarning,
  hapticError,
  hapticSelection
} from './haptics';

jest.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: jest.fn(),
    notification: jest.fn(),
    selectionChanged: jest.fn()
  },
  ImpactStyle: {
    Light: 'LIGHT',
    Medium: 'MEDIUM',
    Heavy: 'HEAVY'
  },
  NotificationType: {
    Success: 'SUCCESS',
    Warning: 'WARNING',
    Error: 'ERROR'
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

jest.mock('lib/settings/helpers', () => ({
  isHapticFeedbackEnabled: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsHapticEnabled = isHapticFeedbackEnabled as jest.MockedFunction<typeof isHapticFeedbackEnabled>;

describe('haptics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('when on mobile with haptics enabled', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsHapticEnabled.mockReturnValue(true);
    });

    it('hapticLight calls Haptics.impact with Light style', async () => {
      await hapticLight();
      expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Light });
    });

    it('hapticMedium calls Haptics.impact with Medium style', async () => {
      await hapticMedium();
      expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Medium });
    });

    it('hapticHeavy calls Haptics.impact with Heavy style', async () => {
      await hapticHeavy();
      expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Heavy });
    });

    it('hapticSuccess calls Haptics.notification with Success type', async () => {
      await hapticSuccess();
      expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Success });
    });

    it('hapticWarning calls Haptics.notification with Warning type', async () => {
      await hapticWarning();
      expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Warning });
    });

    it('hapticError calls Haptics.notification with Error type', async () => {
      await hapticError();
      expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Error });
    });

    it('hapticSelection calls Haptics.selectionChanged', async () => {
      await hapticSelection();
      expect(Haptics.selectionChanged).toHaveBeenCalled();
    });
  });

  describe('when not on mobile', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(false);
      mockIsHapticEnabled.mockReturnValue(true);
    });

    it('hapticLight does not call Haptics', async () => {
      await hapticLight();
      expect(Haptics.impact).not.toHaveBeenCalled();
    });

    it('hapticMedium does not call Haptics', async () => {
      await hapticMedium();
      expect(Haptics.impact).not.toHaveBeenCalled();
    });

    it('hapticHeavy does not call Haptics', async () => {
      await hapticHeavy();
      expect(Haptics.impact).not.toHaveBeenCalled();
    });

    it('hapticSuccess does not call Haptics', async () => {
      await hapticSuccess();
      expect(Haptics.notification).not.toHaveBeenCalled();
    });

    it('hapticWarning does not call Haptics', async () => {
      await hapticWarning();
      expect(Haptics.notification).not.toHaveBeenCalled();
    });

    it('hapticError does not call Haptics', async () => {
      await hapticError();
      expect(Haptics.notification).not.toHaveBeenCalled();
    });

    it('hapticSelection does not call Haptics', async () => {
      await hapticSelection();
      expect(Haptics.selectionChanged).not.toHaveBeenCalled();
    });
  });

  describe('when haptics disabled', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsHapticEnabled.mockReturnValue(false);
    });

    it('hapticLight does not call Haptics', async () => {
      await hapticLight();
      expect(Haptics.impact).not.toHaveBeenCalled();
    });

    it('hapticMedium does not call Haptics', async () => {
      await hapticMedium();
      expect(Haptics.impact).not.toHaveBeenCalled();
    });

    it('hapticSelection does not call Haptics', async () => {
      await hapticSelection();
      expect(Haptics.selectionChanged).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsHapticEnabled.mockReturnValue(true);
    });

    it('hapticLight handles errors gracefully', async () => {
      (Haptics.impact as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticLight()).resolves.not.toThrow();
    });

    it('hapticSuccess handles errors gracefully', async () => {
      (Haptics.notification as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticSuccess()).resolves.not.toThrow();
    });

    it('hapticSelection handles errors gracefully', async () => {
      (Haptics.selectionChanged as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticSelection()).resolves.not.toThrow();
    });

    it('hapticMedium handles errors gracefully', async () => {
      (Haptics.impact as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticMedium()).resolves.not.toThrow();
    });

    it('hapticHeavy handles errors gracefully', async () => {
      (Haptics.impact as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticHeavy()).resolves.not.toThrow();
    });

    it('hapticWarning handles errors gracefully', async () => {
      (Haptics.notification as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticWarning()).resolves.not.toThrow();
    });

    it('hapticError handles errors gracefully', async () => {
      (Haptics.notification as jest.Mock).mockRejectedValueOnce(new Error('Device not supported'));
      await expect(hapticError()).resolves.not.toThrow();
    });
  });
});
