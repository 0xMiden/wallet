import './main.css';

import React from 'react';

import { createRoot } from 'react-dom/client';

import App from 'app/App';
import { WindowType } from 'app/env';
import { initTheme } from 'lib/settings/theme';

initTheme();

// Disable animations for extension
// Animations enabled for extension

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App env={{ windowType: WindowType.FullPage }} />);
