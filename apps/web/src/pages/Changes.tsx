/**
 * Change requests screen: list (pending by default), impact preview, votes,
 * and approve / reject / withdraw actions.
 */
import { useState } from 'react';
import { get, post } from '../api';
import { ErrorBox, Pill, useAction, useAsync } from '../components';
import { fmtTime, useT } from '../i18n';
import type { Capabilities, ChangeRequest } from '../types';

/** Renders the impact preview stored on a change request. */
export function ImpactView({ impact }: { impact: ChangeRequest['impact'] }) {
  const { t } = useT();
  if (impact.type === 'availability') {
    if (!impact.lines?.length) return <p className="muted">{t('none')}</p>;
    return (
      <ul className="impact">
        {impact.lines.map((l) => (
          <li key={`${l.featureCode}-${String(l.to)}`}>
            <span className="mono">{l.featureCode}</span> {l.to ? t('becomesOn') : t('becomesOff')} — {l.nodes} {t('impactNodes')}{' '}
            <span className="muted">({l.sample.join(', ')}{l.nodes > l.sample.length ? ', …' : ''})</span>
          </li>
        ))}
        {impact.truncated && <li className="warn">…</li>}
      </ul>
    );
  }
  if (impact.type === 'permission') {
    return (
      <p>
        <span className="mono">{impact.role}</span>: [{impact.before?.join(', ')}] → [{impact.after?.join(', ')}]
      </p>
    );
  }
  return <p className="muted">{impact.note}</p>;
}

/** Tone for a status pill. */
const tone = (s: ChangeRequest['status']) => (s === 'APPLIED' ? 'ok' : s === 'PENDING' ? 'warn' : s === 'REJECTED' ? 'off' : 'info');

export function ChangesPage({ nodeId, caps, myUserId }: { nodeId: string; caps: Capabilities; myUserId: string }) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<'PENDING' | ''>('PENDING');
  const { data, error, loading, reload } = useAsync(
    () => get<{ changeRequests: ChangeRequest[] }>(`/api/v1/change-requests?nodeId=${encodeURIComponent(nodeId)}${status ? `&status=${status}` : ''}`, locale),
    [nodeId, status, locale]
  );
  const [message, setMessage] = useState<string | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const canApprove = Boolean(caps['platform.change_requests']?.approve);

  /** Casts a vote and shows the outcome (including a one-time password after a credential reset). */
  const vote = useAction(async (id: string, verdict: 'APPROVE' | 'REJECT') => {
    const r = await post<{ status: string; code?: string; oneTimePassword?: string }>(`/api/v1/change-requests/${id}/votes`, { verdict }, locale);
    setMessage(r.status === 'APPLIED' ? t('applied') : r.status === 'REJECTED' ? `${t('rejected')}${r.code ? ` (${r.code})` : ''}` : t('recorded'));
    setOtp(r.oneTimePassword ?? null);
    reload();
  });
  const withdraw = useAction(async (id: string) => {
    await post(`/api/v1/change-requests/${id}/withdraw`, {}, locale);
    reload();
  });

  return (
    <section>
      <div className="row spread">
        <h2>{t('changesTitle')}</h2>
        <div className="row" role="group">
          <button type="button" className={status === 'PENDING' ? '' : 'secondary'} onClick={() => setStatus('PENDING')}>
            {t('pending')}
          </button>
          <button type="button" className={status === '' ? '' : 'secondary'} onClick={() => setStatus('')}>
            {t('all')}
          </button>
        </div>
      </div>
      {message && (
        <p className="ok" role="status">
          {message}
        </p>
      )}
      {otp && (
        <div className="card warn" role="status">
          {t('newPasswordOnce')} <code data-testid="otp">{otp}</code>
        </div>
      )}
      <ErrorBox error={vote.error ?? withdraw.error} />
      {loading && <p>{t('loading')}</p>}
      <ErrorBox error={error} onRetry={reload} />
      {data?.changeRequests.length === 0 && <p className="muted">{t('none')}</p>}
      {data?.changeRequests.map((cr) => {
        const voted = cr.votes.some((v) => v.approverId === myUserId);
        const approvals = cr.votes.filter((v) => v.verdict === 'APPROVE').length;
        return (
          <article key={cr.id} className="card" data-cr={cr.id} data-kind={cr.kind}>
            <header className="row spread">
              <h3>
                {cr.kind} <span className="muted">@ {cr.nodeId}</span>
              </h3>
              <Pill tone={tone(cr.status)}>{cr.status}</Pill>
            </header>
            <pre className="payload">{JSON.stringify(cr.payload, null, 2)}</pre>
            <p>
              <strong>{t('reason')}:</strong> {cr.reason}
            </p>
            <p className="muted">
              {t('proposedBy')}: {cr.proposedByName ?? cr.proposedBy} · {fmtTime(cr.proposedAt, locale)} · {t('expires')}: {fmtTime(cr.expiresAt, locale)}
            </p>
            <h4>{t('impact')}</h4>
            <ImpactView impact={cr.impact} />
            <h4>
              {t('votes')} ({approvals}/{cr.requiredApprovals})
            </h4>
            <ul>
              {cr.votes.map((v) => (
                <li key={v.approverId}>
                  {v.verdict === 'APPROVE' ? '✔' : '✖'} {v.approverName ?? v.approverId} · {fmtTime(v.at, locale)} {v.comment && v.comment !== 'proposer' ? `— ${v.comment}` : ''}
                </li>
              ))}
            </ul>
            {cr.outcome && <pre className="payload">{JSON.stringify(cr.outcome)}</pre>}
            {cr.status === 'PENDING' && (
              <div className="row">
                {canApprove && !voted && (
                  <>
                    <button type="button" data-testid="approve" disabled={vote.busy} onClick={() => void vote.run(cr.id, 'APPROVE')}>
                      {t('approve')}
                    </button>
                    <button type="button" data-testid="reject" className="danger" disabled={vote.busy} onClick={() => void vote.run(cr.id, 'REJECT')}>
                      {t('reject')}
                    </button>
                  </>
                )}
                {cr.proposedBy === myUserId && (
                  <button type="button" className="secondary" disabled={withdraw.busy} onClick={() => void withdraw.run(cr.id)}>
                    {t('withdraw')}
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
