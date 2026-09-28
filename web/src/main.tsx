import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initAuth } from './auth.ts';
import { ToastProvider } from './components/toast.tsx';
import './styles.css';

// finish a sign-in redirect (or restore the session) first – the app then starts signed in, no flicker
void initAuth().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>,
  ),
);
