// Run from repository root. The temporary Jest case uses existing test boundary
// mocks, but renders the real HistoryView, ActivityRow, Card and StatusBadge.
const fs=require('fs');const {spawnSync}=require('child_process');
const target='src/app/templates/history/HistoryView.test.tsx';
const original=fs.readFileSync(target,'utf8');
const snippet=String.raw`
it('exports isolated progress fixture markup', () => {
  mockRealActivityRow = true;
  const en: Record<string, string> = require('../../../../public/_locales/en/en.json');
  mockT.mockImplementation((key: string, options?: Record<string, unknown>) => {
    let text = en[key] ?? key;
    for (const [name, value] of Object.entries(options ?? {})) text = text.replaceAll('$' + name + '$', String(value));
    return text;
  });
  const rows = [
    ['partial-cancelled', 'reclaimed', '99.9'], ['never-filled', 'reclaimed', '0'],
    ['cancelling-partial', 'reclaiming', '40'], ['fully-filled', undefined, '100'],
    ['unknown-fill', 'reclaimed', undefined]
  ];
  const entries = rows.map(([key, swapSettlement, swapFillProgress]) => makeEntry({
    key, txType: 'swap', transactionIcon: 'SWAP', token: 'USDCX', amount: '1',
    requestedToken: 'ETH', requestedAmount: '0.00041621', swapSettlement, swapFillProgress,
    timestamp: 1792678737
  }));
  const { container } = render(<HistoryView {...baseProps} entries={entries} fullHistory />);
  const fs = require('fs');
  // Use the actual shipped SVG inside the icon boundary's placeholder.
  const svg = fs.readFileSync('src/app/icons/v2/convert.svg','utf8');
  container.querySelectorAll('[data-name="Convert"]').forEach(el => {el.innerHTML = svg;});
  fs.writeFileSync('screenshots/partial-swap-fill-progress/fixture-body.html', container.innerHTML);
});
`;
try {
 fs.writeFileSync(target,original+'\n'+snippet);
 const r=spawnSync('node_modules/.bin/jest',[target,'--runInBand','--silent','-t','exports isolated progress fixture markup'],{stdio:'inherit'});
 if(r.status!==0)process.exitCode=r.status;
} finally {fs.writeFileSync(target,original);}
const folder='screenshots/partial-swap-fill-progress';
const body=fs.readFileSync(folder+'/fixture-body.html','utf8');
fs.writeFileSync(folder+'/index.html',`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/main.css"><title>Swap fill progress — isolated fixture</title></head><body class="bg-page text-ink"><main style="max-width:760px;margin:24px auto;padding:16px"><p style="font:700 12px Inter,sans-serif;color:#A84A18;margin-bottom:14px">MOCK DATA · LOCAL COMPONENT PREVIEW</p><h1 style="font:800 26px Nunito,sans-serif;margin-bottom:8px">Swap Activity</h1><p style="font:14px Inter,sans-serif;margin-bottom:24px">Partial → cancelled · unfilled → cancelled · reclaim pending · full fill · unknown progress</p>${body}<p style="font:12px Inter,sans-serif;margin-top:20px">Actual HistoryView / ActivityRow components with isolated fixture entries. No wallet, keys, network sync or transactions.</p></main></body></html>`);
