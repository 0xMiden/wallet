import androidGlobalSetup from './global-setup';
import { probeMobileLegs } from '../../helpers/dapp-live-probe';

/** The dApp legs' live probes before the base setup's emulator pair, so a dead faucet or node is named first. */
export default async function globalSetup(): Promise<void> {
  await probeMobileLegs();
  await androidGlobalSetup();
}
