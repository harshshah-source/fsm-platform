import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installAuthFetch } from './api/http';
import './index.css';

// Install the central 401 → refresh → retry policy over window.fetch once, before anything fetches.
installAuthFetch();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
