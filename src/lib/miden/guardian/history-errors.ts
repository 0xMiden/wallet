export class GuardianHistoryFeeUnavailableError extends Error {
  constructor() {
    super('Guardian history fee metadata is unavailable');
    this.name = 'GuardianHistoryFeeUnavailableError';
  }
}
