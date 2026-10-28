/**
 * Console root: decides between the sign-in flow and the main shell, owns the
 * selected area (jurisdiction node), and builds navigation from the caller's
 * capability map, so the UI never shows functions the API would refuse.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, get, setCsrf, setSessionLostHandler } from './api';
import { ErrorBoundary, ErrorBox, useAsync } from './components';
import { DICTS, LocaleContext, useT, type TKey } from './i18n';
import { ChangePasswordForm, LoginForm, MfaEnrollForm, MfaVerifyForm, type NextStep } from './pages/SignIn';
import { ModulesPage } from './pages/Modules';
import { RegistryPage } from './pages/Registry';
import { OrgPage } from './pages/Org';
import { ClassificationPage } from './pages/Classification';
import { ChangesPage } from './pages/Changes';
import { UsersPage } from './pages/Users';
import { KillPage } from './pages/Kill';
import { AuditPage } from './pages/Audit';
import { SessionsPage } from './pages/Sessions';
import type { Capabilities, SessionInfo, TreeNode } from './types';
import { getRole, type Locale } from '@np/shared';

/** Tabs and the capability that makes each visible. */
const TABS: { id: string; label: TKey; needs?: [string, string] }[] = [
  { id: 'modules', label: 'nav_modules', needs: ['platform.modules', 'view'] },
  { id: 'registry', label: 'nav_registry', needs: ['registry.offices', 'view'] },
  { id: 'org', label: 'nav_org', needs: ['org.directory', 'view'] },
  { id: 'classification', label: 'nav_classification', needs: ['platform.scope', 'view'] },
  { id: 'changes', label: 'nav_changes', needs: ['platform.change_requests', 'view'] },
  { id: 'users', label: 'nav_users', needs: ['iam.users', 'view'] },
  { id: 'kill', label: 'nav_kill', needs: ['platform.kill_switch', 'view'] },
  { id: 'audit', label: 'nav_audit', needs: ['audit.ledger', 'view'] },
  { id: 'sessions', label: 'nav_sessions' }
];

/** Reads the tab from the URL hash so reloads keep the screen. */
const tabFromHash = () => location.hash.replace(/^#\/?/, '') || 'modules';

export function App() {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      return (localStorage.getItem('np.locale') as Locale) === 'en' ? 'en' : 'hi';
    } catch {
      return 'hi';
    }
  });
  /** Changes language locally and, when signed in, on the account (best effort). */
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('np.locale', l);
    } catch {
      /* storage unavailable: preference lasts for this page only */
    }
    void api('PUT', '/api/v1/auth/locale', { locale: l }).catch(() => undefined);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `${DICTS[locale].appName} · ${DICTS[locale].appTagline}`;
  }, [locale]);

  // undefined = still checking; null = signed out.
  const [step, setStep] = useState<NextStep | null | undefined>(undefined);
  const [session, setSession] = useState<SessionInfo | null>(null);

  /** Loads the current session (also refreshes the CSRF token after reloads). */
  const loadSession = useCallback(async () => {
    try {
      const s = await get<SessionInfo>('/api/v1/auth/session', locale);
      setCsrf(s.csrfToken);
      setSession(s);
      setStep(s.next);
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'NP-AUTH-0001') console.warn('session check failed', e);
      setSession(null);
      setStep(null);
    }
  }, [locale]);

  useEffect(() => {
    setSessionLostHandler(() => {
      setCsrf(null);
      setSession(null);
      setStep(null);
    });
    void loadSession();
    // Only on first mount; later loads happen after sign-in steps.
  }, []);

  /** After each sign-in step: READY loads the session, other steps render their form. */
  const onNext = (n: NextStep) => {
    if (n === 'READY') void loadSession();
    else setStep(n);
  };
  const signedOut = () => {
    setCsrf(null);
    setSession(null);
    setStep(null);
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <ErrorBoundary fallback={(reset) => <Crash reset={reset} />}>
        <TopBar session={step === 'READY' ? session : null} onSignedOut={signedOut} />
        <main>
          {step === undefined && <p className="center">{DICTS[locale].loading}</p>}
          {step === null && <LoginForm onNext={onNext} />}
          {step === 'CHANGE_PASSWORD' && <ChangePasswordForm onNext={onNext} />}
          {step === 'MFA_ENROLL' && <MfaEnrollForm onNext={onNext} />}
          {step === 'MFA_VERIFY' && <MfaVerifyForm onNext={onNext} onSignOut={signedOut} />}
          {step === 'READY' && session && <Shell session={session} />}
        </main>
      </ErrorBoundary>
    </LocaleContext.Provider>
  );
}

/** Shown when a screen crashes; the error was already reported with NP-CLIENT-0002. */
function Crash({ reset }: { reset: () => void }) {
  const { t } = useT();
  return (
    <div className="card narrow">
      <ErrorBox error={new ApiError('NP-CLIENT-0002', DICTS.en.loading, 0)} />
      <button type="button" onClick={reset}>
        {t('retry')}
      </button>
    </div>
  );
}

/** Header: app name, language switch, user and sign-out. */
function TopBar({ session, onSignedOut }: { session: SessionInfo | null; onSignedOut: () => void }) {
  const { t, locale, setLocale } = useT();
  return (
    <header className="topbar">
      <div>
        <strong>{t('appName')}</strong> <span className="muted">{t('appTagline')}</span>
      </div>
      <div className="row">
        <button type="button" data-testid="lang-toggle" className="link" onClick={() => setLocale(locale === 'hi' ? 'en' : 'hi')} lang={locale === 'hi' ? 'en' : 'hi'}>
          {t('language')}
        </button>
        {session && (
          <>
            <span data-testid="whoami">{session.user.displayName}</span>
            <button type="button" className="secondary small" onClick={() => void api('POST', '/api/v1/auth/logout', {}).catch(() => undefined).finally(onSignedOut)}>
              {t('signOut')}
            </button>
          </>
        )}
      </div>
    </header>
  );
}

/** Main shell: area picker, capability-driven tabs, current page. */
function Shell({ session }: { session: SessionInfo }) {
  const { t, locale } = useT();
  const homes = [...new Map(session.assignments.map((a) => [a.nodeId, a])).values()];
  const [nodeId, setNodeId] = useState<string>(homes[0]?.nodeId ?? '');
  const [tab, setTab] = useState(tabFromHash());
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tree = useAsync(() => (nodeId ? get<{ path: { id: string; nameEn: string; nameHi: string }[]; node: TreeNode }>(`/api/v1/scopes/tree?rootId=${encodeURIComponent(nodeId)}&depth=1`, locale) : Promise.resolve(null)), [nodeId, locale]);
  const caps = useAsync(() => (nodeId ? get<{ capabilities: Capabilities }>(`/api/v1/capabilities?nodeId=${encodeURIComponent(nodeId)}`, locale) : Promise.resolve({ capabilities: {} })), [nodeId, locale]);
  const c: Capabilities = caps.data?.capabilities ?? {};
  const visible = TABS.filter((x) => !x.needs || c[x.needs[0]]?.[x.needs[1] as 'view']);
  const current = visible.find((x) => x.id === tab) ? tab : (visible[0]?.id ?? 'sessions');
  // The user's home areas bound how far up the tree they can navigate.
  const homeIds = new Set(homes.map((h) => h.nodeId));
  const path = tree.data?.path ?? [];
  const homeIndex = path.findIndex((p) => homeIds.has(p.id));

  if (homes.length === 0) {
    return (
      <div className="card narrow">
        <p>{t('noAccess')}</p>
        <SessionsPage />
      </div>
    );
  }

  return (
    <div className="shell">
      <aside>
        <h3>{t('yourRoles')}</h3>
        <ul className="plain">
          {session.assignments.map((a) => (
            <li key={`${a.role}@${a.nodeId}`}>
              <button type="button" className={a.nodeId === nodeId ? 'link active' : 'link'} onClick={() => setNodeId(a.nodeId)}>
                {(locale === 'hi' ? getRole(a.role)?.nameHi : getRole(a.role)?.nameEn) ?? a.role} · {locale === 'hi' ? a.nodeNameHi : a.nodeNameEn}
              </button>
            </li>
          ))}
        </ul>
        <h3>{t('area')}</h3>
        <nav aria-label={t('area')} className="crumbs">
          {path.map((p, i) => (
            <span key={p.id}>
              {i >= homeIndex && homeIndex >= 0 ? (
                <button type="button" className="link" onClick={() => setNodeId(p.id)}>
                  {locale === 'hi' ? p.nameHi : p.nameEn}
                </button>
              ) : (
                <span className="muted">{locale === 'hi' ? p.nameHi : p.nameEn}</span>
              )}
              {i < path.length - 1 ? ' › ' : ''}
            </span>
          ))}
        </nav>
        {tree.data?.node.children && tree.data.node.children.length > 0 && (
          <>
            <h4>{t('subAreas')}</h4>
            <ul className="plain">
              {tree.data.node.children.map((ch) => (
                <li key={ch.id}>
                  <button type="button" className="link" onClick={() => setNodeId(ch.id)}>
                    {locale === 'hi' ? ch.nameHi : ch.nameEn} <span className="muted">({ch.level})</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorBox error={tree.error ?? caps.error} />
      </aside>
      <section className="content">
        <nav className="tabs" aria-label="sections">
          {visible.map((x) => (
            <a key={x.id} href={`#/${x.id}`} className={x.id === current ? 'active' : ''} aria-current={x.id === current ? 'page' : undefined}>
              {t(x.label)}
            </a>
          ))}
        </nav>
        {caps.loading ? (
          <p>{t('loading')}</p>
        ) : (
          <ErrorBoundary key={`${current}:${nodeId}`} fallback={(reset) => <Crash reset={reset} />}>
            {current === 'modules' && <ModulesPage nodeId={nodeId} caps={c} />}
            {current === 'registry' && <RegistryPage nodeId={nodeId} caps={c} />}
            {current === 'org' && <OrgPage nodeId={nodeId} caps={c} />}
            {current === 'classification' && <ClassificationPage nodeId={nodeId} caps={c} />}
            {current === 'changes' && <ChangesPage nodeId={nodeId} caps={c} myUserId={session.user.id} />}
            {current === 'users' && <UsersPage nodeId={nodeId} nodeLevel={tree.data?.node.level ?? ''} caps={c} myUserId={session.user.id} />}
            {current === 'kill' && <KillPage nodeId={nodeId} caps={c} />}
            {current === 'audit' && <AuditPage nodeId={nodeId} caps={c} />}
            {current === 'sessions' && <SessionsPage />}
          </ErrorBoundary>
        )}
      </section>
    </div>
  );
}
