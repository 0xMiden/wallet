describe('transaction failure SDK version', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../package.json');
    jest.dontMock('@miden-sdk/miden-sdk/package.json');
    jest.dontMock('./crash');
  });

  it.each([
    ['pinned dependency', '0.17.5', '0.17.5', '0.17.5'],
    ['linked dependency', 'file:../sdk', '0.17.6', '0.17.6'],
    ['invalid installed version', '0.17.5', 'invalid-version', 'unavailable']
  ])('reports installed metadata for %s', (_name, dependency, installed, expected) => {
    jest.resetModules();
    jest.doMock('../../../package.json', () => {
      const actual = jest.requireActual<typeof import('../../../package.json')>('../../../package.json');
      return { ...actual, dependencies: { ...actual.dependencies, '@miden-sdk/miden-sdk': dependency } };
    });
    jest.doMock('@miden-sdk/miden-sdk/package.json', () => ({ version: installed }));
    jest.doMock('./crash', () => ({ captureCrash: jest.fn() }));

    jest.isolateModules(() => {
      const { reportTransactionFailure } = jest.requireActual<typeof import('./transaction-failure')>(
        './transaction-failure'
      );
      const { captureCrash } = jest.requireMock<typeof import('./crash')>('./crash');
      reportTransactionFailure({ type: 'send' });
      const error = jest.mocked(captureCrash).mock.calls[0]?.[0];
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Missing transaction failure report');
      expect(error.message).toContain(`SDK ${expected}; Guardian client`);
      expect(error.message).not.toContain('invalid-version');
    });
  });
});
