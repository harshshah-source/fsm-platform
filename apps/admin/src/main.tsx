import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installAuthFetch } from './api/http';
import { applyStoredTheme } from './lib/applyStoredTheme';
import './index.css';

// Install the central 401 → refresh → retry policy over window.fetch once, before anything fetches.
installAuthFetch();

// Paint the stored theme before React mounts, or a dark-mode reload flashes the light canvas first.
applyStoredTheme();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
