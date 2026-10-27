import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../../src/i18n';
import '../../../src/main.css';
import {ArcadeAllowance} from '../../../src/app/templates/ArcadeAllowance';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
createRoot(document.getElementById('root')!).render(<React.Suspense fallback={null}><AwaitFonts name="Inter" weights={[400,500,600]} className="antialiased font-inter"><AwaitFonts name="Nunito" weights={[700,800]}><main className="h-full bg-app-bg p-4 text-ink"><ArcadeAllowance/></main></AwaitFonts></AwaitFonts></React.Suspense>);
