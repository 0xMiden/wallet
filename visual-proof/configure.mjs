import fs from 'node:fs';
const path = 'src/app/pages/TokenDetail.tsx';
let source = fs.readFileSync(path, 'utf8');
const replace = (before, after) => {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('Fixture source mismatch');
  source = source.replace(before, after);
};
replace("  const priceSymbol = priceSymbolFor(tokenId, symbol);\n  const quote = quotedPrice(tokenPrices, priceSymbol);", "  const priceSymbol = 'ETH';\n  const quote = { price: 2500, change24h: 25, percentageChange24h: 1 }; ");
const start = source.indexOf("  const { data: klineData } = useRetryableSWR(['kline', symbol, timeframe]");
const end = source.indexOf('\n\n  // `fetchKlineData`', start);
if (start < 0 || end < 0) throw new Error('Kline fixture source mismatch');
source = source.slice(0, start) + '  const klineData: { time: number; value: number }[] = [];' + source.slice(end);
fs.writeFileSync(path, source);
