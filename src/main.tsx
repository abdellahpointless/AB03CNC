import { Component, StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import i18n from './i18n';
import { installPressFeedback } from './lib/pressFeedback';
import { INSTANCE, countryPath, homeCountry, rememberCountry, wantsCountryPicker } from './lib/instance';
import './index.css';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { UpdateBanner } from './components/UpdateBanner';

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
 *
 * Only the country picker and the sign-in page are public. The app itself (App, MasterApp and
 * everything they load) is built into /app/<access>/ files that the Worker hands out only to a
 * signed-in session with the right access (see vite-private-chunks.ts and worker/assets.ts), so
 * it is loaded only once someone is signed in.
 */
const App = lazy(() => import('./App'));
const HubPage = lazy(() => import('./components/HubPage'));
const MasterApp = lazy(() => import('./components/MasterApp'));
const Login = lazy(() => import('./components/Login'));

/** A part of the app could not be loaded (session ended, or a new version replaced the files). */
class LoadFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <button type="button" className="btn-primary" onClick={() => location.reload()}>
          {i18n.t('common:actions.retry')}
        </button>
      </div>
    );
  }
}

function SignedIn() {
  const { user, status } = useAuth();
  if (status === 'loading') return null;
  if (!user) return <Login />;
  return INSTANCE.kind === 'master' ? <MasterApp /> : <App />;
}

function Root() {
  if (INSTANCE.kind === 'hub') return <HubPage />;
  return (
    <AuthProvider>
      <LoadFailed>
        <Suspense fallback={null}>
          <SignedIn />
        </Suspense>
      </LoadFailed>
    </AuthProvider>
  );
}

if (!redirecting) createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honour Windows "show animations" / reduced motion: Motion keeps fades, drops movement. */}
    <MotionConfig reducedMotion="user">
      <Suspense fallback={null}>
        <Root />
      </Suspense>
      <UpdateBanner />
    </MotionConfig>
  </StrictMode>,
);
