export class UsdcxBurnError extends Error {
  /** `values` fills the copy's placeholders, such as the fee allowance a burn must exceed. */
  constructor(
    readonly translationKey: string,
    readonly values?: Record<string, string>
  ) {
    super(translationKey);
    this.name = 'UsdcxBurnError';
  }
}
