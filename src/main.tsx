import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import './i18n';
import { installPressFeedback } from './lib/pressFeedback';
import { INSTANCE, countryPath, homeCountry, rememberCountry, wantsCountryPicker } from './lib/instance';
import './index.css';
import { AuthProvider } from './contexts/AuthContext';

installPressFeedback();

/*
 * The country is chosen once. The site's address then always opens that country, until the
 * person asks to change country (the "change country" links open /?choose).
 */
let redirecting = false;
if (INSTANCE.kind === 'hub' && !wantsCountryPicker()) {
  const home = homeCountry();
  if (home) {
    redirecting = true;
    location.replace(countryPath(home));
  }
} else if (INSTANCE.kind === 'country') {
  rememberCountry(INSTANCE.region.id);
}

// The tab title names the instance (useful on PCs that have two countries open).
if (INSTANCE.kind === 'country') document.title = `CNC Process Pro · ${INSTANCE.region.name}`;
else if (INSTANCE.kind === 'master') document.title = 'CNC Process Pro · Master';

/*
 * One link, three kinds of page:
 *   /            country picker
 *   /ma/, /tr/   a country's app (its own database, accounts, machines, language)
 *   /master/     the master dashboard
 */
const App = lazy(() => import('./App'));
const HubPage = lazy(() => import('./components/HubPage'));
const MasterApp = lazy(() => import('./components/MasterApp'));

function Root() {
  if (INSTANCE.kind === 'hub') return <HubPage />;
  return <AuthProvider>{INSTANCE.kind === 'master' ? <MasterApp /> : <App />}</AuthProvider>;
}

if (!redirecting) createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honour Windows "show animations" / reduced motion: Motion keeps fades, drops movement. */}
    <MotionConfig reducedMotion="user">
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </MotionConfig>
  </StrictMode>,
);
