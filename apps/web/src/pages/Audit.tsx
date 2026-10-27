/**
 * Audit log viewer (newest first, paged) and the integrity verification button.
 */
import { useState } from 'react';
import { get, post } from '../api';
import { ErrorBox, Field, useAction, useAsync } from '../components';
import { fmtTime, useT } from '../i18n';
import type { AuditEvent, Capabilities } from '../types';

interface VerifyResult {
  ok: boolean;
  entriesChecked: number;
  checkpointsChecked: number;
  firstBadSeq: string | null;
  badCheckpoints: { upToSeq: string; reason: string }[];
  errCode: string | null;
}

export function AuditPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<AuditEvent[][]>([]);
  const filter = action.trim();
  const first = useAsync(
    () => get<{ events: AuditEvent[] }>(`/api/v1/audit/events?nodeId=${encodeURIComponent(nodeId)}&limit=50${filter ? `&action=${encodeURIComponent(filter)}` : ''}`, locale),
    [nodeId, filter, locale]
  );
  const all = [...(first.data?.events ?? []), ...pages.flat()];
  const more = useAction(async () => {
    const last = all.at(-1);
    if (!last) return;
    const r = await get<{ events: AuditEvent[] }>(
      `/api/v1/audit/events?nodeId=${encodeURIComponent(nodeId)}&limit=50&beforeSeq=${last.seq}${filter ? `&action=${encodeURIComponent(filter)}` : ''}`,
      locale
    );
    setPages((p) => [...p, r.events]);
  });
  const [result, setResult] = useState<VerifyResult | null>(null);
  const verify = useAction(async () => setResult(await post<VerifyResult>('/api/v1/audit/verify', { nodeId }, locale)));

  return (
    <section>
      <div className="row spread">
        <h2>{t('auditTitle')}</h2>
        {caps['audit.ledger']?.special && (
          <button type="button" data-testid="verify-ledger" onClick={() => void verify.run()} disabled={verify.busy}>
            {t('verifyLedger')}
          </button>
        )}
      </div>
      <ErrorBox error={verify.error} />
      {result && (
        <div className={result.ok ? 'card ok' : 'card error'} role="status" data-verify={result.ok ? 'ok' : 'fail'}>
          <strong>{result.ok ? t('verifyOk') : t('verifyFail')}</strong>
          <div>
            {result.entriesChecked} {t('entriesChecked')} · {result.checkpointsChecked} {t('checkpoints')}
            {result.errCode ? ` · ${result.errCode}` : ''}
            {result.firstBadSeq ? ` · seq ${result.firstBadSeq}` : ''}
          </div>
        </div>
      )}
      <Field label={t('filterAction')}>
        <input
          name="action"
          placeholder="iam.login.failure"
          value={action}
          onChange={(e) => {
            setPages([]);
            setAction(e.target.value.replace(/[^a-z_.]/g, ''));
          }}
        />
      </Field>
      {first.loading && <p>{t('loading')}</p>}
      <ErrorBox error={first.error ?? more.error} onRetry={first.reload} />
      <table className="list audit">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('time')}</th>
            <th>{t('action')}</th>
            <th>{t('actor')}</th>
            <th>{t('target')}</th>
            <th>{t('area')}</th>
          </tr>
        </thead>
        <tbody>
          {all.map((e) => (
            <tr key={e.seq} data-action={e.action}>
              <td className="mono">{e.seq}</td>
              <td>{fmtTime(e.occurredAt, locale)}</td>
              <td className="mono">
                {e.action}
                {e.decision && <span className={`dec dec-${e.decision}`}> {e.decision}</span>}
              </td>
              <td className="mono">
                {e.actorId?.slice(0, 8) ?? '—'} {e.actorRoles.length > 0 && <span className="muted">({e.actorRoles.join(', ')})</span>}
              </td>
              <td className="mono">{e.targetType ? `${e.targetType}:${(e.targetId ?? '').slice(0, 12)}` : '—'}</td>
              <td className="mono">{e.scopePath ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {all.length > 0 && (
        <button type="button" className="secondary" disabled={more.busy} onClick={() => void more.run()}>
          {t('older')}
        </button>
      )}
    </section>
  );
}
