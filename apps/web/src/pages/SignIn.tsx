/**
 * Sign-in flow screens, driven by the server's `next` step:
 *   (no session) → password → CHANGE_PASSWORD → MFA_ENROLL → MFA_VERIFY → READY
 * The server decides the next step; this component only renders it.
 */
import { useState, type FormEvent } from 'react';
import { api, post, setCsrf } from '../api';
import { ErrorBox, Field, useAction } from '../components';
import { useT } from '../i18n';

export type NextStep = 'CHANGE_PASSWORD' | 'MFA_ENROLL' | 'MFA_VERIFY' | 'READY';

/** Password form. On success reports the next step to the parent. */
export function LoginForm({ onNext }: { onNext: (n: NextStep) => void }) {
  const { t, locale } = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<{ csrfToken: string; next: NextStep }>('/api/v1/auth/login', { username, password }, locale);
    setCsrf(r.csrfToken);
    // The password is cleared from memory as soon as it is no longer needed.
    setPassword('');
    onNext(r.next);
  });
  return (
    <form onSubmit={(e) => void action.run(e)} className="card narrow" aria-labelledby="login-title">
      <h1 id="login-title">{t('signIn')}</h1>
      <Field label={t('username')}>
        <input name="username" autoComplete="username" required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label={t('password')}>
        <input name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorBox error={action.error} />
      <button type="submit" disabled={action.busy}>
        {action.busy ? t('signingIn') : t('signIn')}
      </button>
    </form>
  );
}

/** Forced first-password change (also used later from the sessions page). */
export function ChangePasswordForm({ onNext }: { onNext: (n: NextStep) => void }) {
  const { t, locale } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    // Client-side check is only a convenience; the server enforces the real policy.
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const r = await post<{ next: NextStep }>('/api/v1/auth/password', { currentPassword: current, newPassword: next }, locale);
    onNext(r.next);
  });
  return (
    <form onSubmit={(e) => void action.run(e)} className="card narrow">
      <h1>{t('changePasswordTitle')}</h1>
      <p className="help">{t('changePasswordHelp')}</p>
      <Field label={t('currentPassword')}>
        <input name="currentPassword" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={t('newPassword')}>
        <input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={t('confirmPassword')}>
        <input name="confirmPassword" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      {mismatch && <div className="error" role="alert">{t('passwordsDiffer')}</div>}
      <ErrorBox error={action.error} />
      <button type="submit" disabled={action.busy}>
        {t('save')}
      </button>
    </form>
  );
}

/** Authenticator enrolment: fetch QR, then confirm with the first code. */
export function MfaEnrollForm({ onNext }: { onNext: (n: NextStep) => void }) {
  const { t, locale } = useT();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useAction(async () => {
    setSetup(await post<{ secret: string; qrDataUrl: string }>('/api/v1/auth/mfa/enroll/start', {}, locale));
  });
  const confirm = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<{ csrfToken: string; next: NextStep }>('/api/v1/auth/mfa/enroll/confirm', { code }, locale);
    // The session token was rotated on success; the CSRF token changes with it.
    setCsrf(r.csrfToken);
    setSetup(null);
    onNext(r.next);
  });
  return (
    <div className="card narrow">
      <h1>{t('mfaEnrollTitle')}</h1>
      <p className="help">{t('mfaEnrollHelp')}</p>
      {!setup ? (
        <>
          <ErrorBox error={start.error} />
          <button type="button" data-testid="start-mfa" onClick={() => void start.run()} disabled={start.busy}>
            {t('startSetup')}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void confirm.run(e)}>
          <img src={setup.qrDataUrl} alt="QR" width={240} height={240} className="qr" />
          <p className="help">
            {t('mfaManual')} <code data-testid="totp-secret">{setup.secret}</code>
          </p>
          <Field label={t('code')}>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <ErrorBox error={confirm.error} />
          <button type="submit" disabled={confirm.busy}>
            {t('verify')}
          </button>
        </form>
      )}
    </div>
  );
}

/** Second-factor check for an already enrolled account. `onSignOut` abandons the sign-in. */
export function MfaVerifyForm({ onNext, onSignOut }: { onNext: (n: NextStep) => void; onSignOut: () => void }) {
  const { t, locale } = useT();
  const [code, setCode] = useState('');
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<{ csrfToken: string; next: NextStep }>('/api/v1/auth/mfa/verify', { code }, locale);
    setCsrf(r.csrfToken);
    onNext(r.next);
  });
  return (
    <form onSubmit={(e) => void action.run(e)} className="card narrow">
      <h1>{t('mfaVerifyTitle')}</h1>
      <p className="help">{t('mfaVerifyHelp')}</p>
      <Field label={t('code')}>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </Field>
      <ErrorBox error={action.error} />
      <button type="submit" disabled={action.busy}>
        {t('verify')}
      </button>
      <button type="button" className="link" onClick={() => void api('POST', '/api/v1/auth/logout', {}).catch(() => undefined).finally(onSignOut)}>
        {t('signOut')}
      </button>
    </form>
  );
}
