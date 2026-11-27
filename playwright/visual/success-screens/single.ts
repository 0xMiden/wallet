// Entry for the single-file export: the page in one HTML file that opens by double-click. Built by
// vite.single.config.mts and assembled by build-single.py. The same script also draws one dApp
// confirm window when it finds itself inside one of that tab's frames.
import './single-flag';

if ((globalThis as { __DAPP_ID__?: string }).__DAPP_ID__) void import('./dapp-main');
else void import('./main');
