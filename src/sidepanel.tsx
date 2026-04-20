import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

/* eslint-disable import/first, import/order -- Buffer polyfill above must run before any module that uses Buffer at import time. */

import './main.css';

import React from 'react';

import { createRoot } from 'react-dom/client';

import 'lib/lock-up/run-checks';

import App from 'app/App';
import { WindowType } from 'app/env';
import { initTheme } from 'lib/settings/theme';

initTheme();

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App env={{ windowType: WindowType.SidePanel }} />);
