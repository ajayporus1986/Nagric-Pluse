/** Console entry point: installs global error reporting and mounts the app. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installGlobalErrorHandlers } from './logger';

installGlobalErrorHandlers();
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
