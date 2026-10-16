import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import { MotionConfig } from 'motion/react';
import './index.css';
import { AuthProvider } from './contexts/AuthContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honour Windows "show animations" / reduced motion: Motion keeps fades, drops movement. */}
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <App />
      </AuthProvider>
    </MotionConfig>
  </StrictMode>,
);
