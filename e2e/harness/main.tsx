import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';

// Mirror the app's dark mode switch (class on <html>) from the emulated
// prefers-color-scheme so each Playwright project renders its theme.
document.documentElement.classList.toggle(
  'dark',
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('harness root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <div className="min-h-screen bg-panel p-4 font-sans text-fg">harness ok</div>
  </StrictMode>,
);
