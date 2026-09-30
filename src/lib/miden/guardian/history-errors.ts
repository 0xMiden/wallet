export class GuardianHistoryFeeUnavailableError extends Error {
  constructor() {
    super('Guardian history fee metadata is unavailable');
    this.name = 'GuardianHistoryFeeUnavailableError';
  }
}

export class GuardianHistoryDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GuardianHistoryDataError';
  }
}
