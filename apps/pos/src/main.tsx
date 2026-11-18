import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@bestie/ui/styles.css';
import { GuestRoot, tableTokenFromPath } from '@bestie/guest-ui';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
// /t/<token> is the QR on a table: a guest's phone, no account, no shell.
const guestToken = tableTokenFromPath(window.location.pathname);
createRoot(root).render(
  <StrictMode>{guestToken ? <GuestRoot token={guestToken} /> : <App />}</StrictMode>,
);
