export class GuardianHistoryFeeUnavailableError extends Error {
  constructor() {
    super('Guardian history fee metadata is unavailable');
    this.name = 'GuardianHistoryFeeUnavailableError';
  }
}

/** The wallet's own node could not answer the fee metadata a decode needs; the operator's data was not read. */
export class GuardianHistoryFeeLookupError extends Error {
  constructor(options?: ErrorOptions) {
    super('Guardian history fee metadata is not available yet', options);
    this.name = 'GuardianHistoryFeeLookupError';
  }
}

export class GuardianHistoryDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GuardianHistoryDataError';
  }
}
