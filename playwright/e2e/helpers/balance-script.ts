/**
 * The one store walk both mobile realms evaluate to total a wallet's balances.
 *
 * Emitted as a CDP script body (top-level `return`, the shape `cdp.eval` expects) because the
 * mobile harnesses have no in-page evaluate that can close over imported code.
 *
 * Symbol resolution deliberately matches the Chrome reader: a row carries `metadata` only when
 * `fetchTokenMetadata` succeeded, and the mobile harness injects test-faucet metadata through
 * `setAssetsMetadata` alone - never onto the row - so resolving from `t.metadata.symbol` by itself
 * returns 0 for exactly the CLI-deployed faucet every spec trades.
 */
export function buildBalanceTotalScript(tokenSymbol?: string): string {
  const wanted = tokenSymbol === undefined ? '' : tokenSymbol.toUpperCase();
  return (
    `var s = window.__TEST_STORE__; ` +
    `if (!s) return 0; ` +
    `var st = s.getState(); ` +
    `var want = ${JSON.stringify(wanted)}; ` +
    `var meta = st.assetsMetadata || {}; ` +
    `var total = 0; ` +
    `var balances = st.balances || {}; ` +
    `for (var k in balances) { ` +
    `  var list = balances[k]; ` +
    `  if (!Array.isArray(list)) continue; ` +
    `  for (var i = 0; i < list.length; i++) { ` +
    `    var t = list[i]; ` +
    `    if (want) { ` +
    `      var fallback = meta[String(t.tokenId != null ? t.tokenId : '')] || {}; ` +
    `      var raw = (t.metadata && t.metadata.symbol) ? t.metadata.symbol : fallback.symbol; ` +
    `      if (String(raw || '').toUpperCase() !== want) continue; ` +
    `    } ` +
    `    var amt = parseFloat(String(t.amount != null ? t.amount : (t.balance != null ? t.balance : '0'))); ` +
    `    if (amt > 0) total += amt; ` +
    `  } ` +
    `} ` +
    `return total;`
  );
}
