import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

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
