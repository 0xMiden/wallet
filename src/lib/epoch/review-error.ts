import { getMessage } from 'lib/i18n';

export class EpochReviewChangedError extends Error {
  readonly translationKey = 'bridgeReviewChanged';

  constructor() {
    super(getMessage('bridgeReviewChanged'));
    this.name = 'EpochReviewChangedError';
  }
}
