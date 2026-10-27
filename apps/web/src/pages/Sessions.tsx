/** "My sessions": where I am signed in, with sign-out per device. */
import { api, get } from '../api';
import { ErrorBox, Pill, useAction, useAsync } from '../components';
import { fmtTime, useT } from '../i18n';

interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export function SessionsPage() {
  const { t, locale } = useT();
  const { data, error, reload } = useAsync(() => get<{ sessions: SessionRow[] }>('/api/v1/auth/sessions', locale), [locale]);
  const revoke = useAction(async (id: string) => {
    await api('DELETE', `/api/v1/auth/sessions/${id}`, undefined, locale);
    reload();
  });
  return (
    <section>
      <h2>{t('sessionsTitle')}</h2>
      <ErrorBox error={error ?? revoke.error} onRetry={reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('lastSeen')}</th>
            <th>IP</th>
            <th>Browser</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.sessions.map((s) => (
            <tr key={s.id}>
              <td>{fmtTime(s.last_seen_at, locale)}</td>
              <td className="mono">{s.ip ?? '—'}</td>
              <td className="muted">{(s.user_agent ?? '').slice(0, 80)}</td>
              <td>
                {s.current ? (
                  <Pill tone="info">{t('thisDevice')}</Pill>
                ) : (
                  <button type="button" className="secondary small" disabled={revoke.busy} onClick={() => void revoke.run(s.id)}>
                    {t('revoke')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
