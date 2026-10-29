import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/i18n';
import '../../../src/main.css';
import { StorageRecoveryPage } from '../../../src/app/StorageRecoveryPage';
createRoot(document.getElementById('root')!).render(<React.Suspense fallback={null}><StorageRecoveryPage onBack={() => {}} /></React.Suspense>);
