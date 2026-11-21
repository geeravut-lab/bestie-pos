import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@bestie/ui/styles.css';
import { guestEntry } from '@bestie/guest-ui';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
// /t/<token> (table QR), /book/<token>, /pass/<token>, /join/<network>, /island/<network>, /r/<room token> are a guest's phone: no account, no shell.
createRoot(root).render(<StrictMode>{guestEntry(window.location.pathname) ?? <App />}</StrictMode>);
