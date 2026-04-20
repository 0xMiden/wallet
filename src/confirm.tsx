import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

/* eslint-disable import/first, import/order -- Buffer polyfill above must run before any module that uses Buffer at import time. */

import './main.css';

import React from 'react';

import { createRoot } from 'react-dom/client';

import App from 'app/App';
import { WindowType } from 'app/env';

// Disable animations for extension
// Animations enabled for extension

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App env={{ windowType: WindowType.Popup, confirmWindow: true }} />);
