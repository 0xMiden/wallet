/**
 * The Earn vault names and rules the screens share. Only the bridge-config derivation reads the catalogue
 * (`readEarnVaults` in `./pools-read`, through `lib/remote-config/derive`), so this module reads nothing.
 */
export {
  EARN_LENDER_FAMILY_NAMES,
  earnLenderFamily,
  earnMarketForVault,
  earnVaultTakesDeposits,
  type EarnLenderFamily,
  type EarnVaultInfo
} from './pools-read';
