import {
  readPortfolioObservations,
  recordPortfolioObservation,
  prunePortfolioObservations
} from './portfolio-observations';

// Transaction/settlement tests mock repo exports without opening a Dexie database.
jest.mock('./repo', () => ({ db: undefined, Table: undefined }));

it('does not resolve a database table before an observation operation is requested', () => {
  expect(readPortfolioObservations).toBeDefined();
  expect(recordPortfolioObservation).toBeDefined();
  expect(prunePortfolioObservations).toBeDefined();
});
