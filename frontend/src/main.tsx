import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
    // Ohne Service Worker läuft die App weiter (nur ohne Offline-Cache und
    // Push) — die abgewiesene Registrierung darf trotzdem nicht unbehandelt
    // als Unhandled Rejection enden.
    console.error('Service worker registration failed', err);
  });
}
