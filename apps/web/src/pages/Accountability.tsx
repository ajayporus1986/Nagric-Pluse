/**
 * Official accountability & leadership reporting (Phase 4): process-level
 * KPI dashboard (always visible to anyone with the broad grant), evidence-
 * gated officer metrics (narrower grant), due-process notices (issue -> the
 * named officer's reply -> independent review -> the named officer's
 * appeal), and audited, reason-coded leadership pulls (state/national
 * leadership only). The hourly rollups, monthly push and immediate SLA
 * alerts are worker jobs with no UI of their own — see
 * apps/api/src/worker/jobs.ts.
 */
import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { ErrorBox, Field, useAction, useAsync } from '../components';
import { useT, type TKey } from '../i18n';
import type { Capabilities, LeadershipPull, NoticeDetail, NoticeListItem, OfficerMetricRow, ProcessMetricRow } from '../types';

type SubTab = 'dashboard' | 'officers' | 'notices' | 'pulls';

export function AccountabilityPage({ nodeId, caps, myUserId }: { nodeId: string; caps: Capabilities; myUserId: string }) {
  const { t } = useT();
  const [sub, setSub] = useState<SubTab>('dashboard');
  const canSeeOfficers = Boolean(caps['accountability.officers']?.view);
  const canSeeNotices = Boolean(caps['accountability.notices']?.view);
  const canSeePulls = Boolean(caps['accountability.pulls']?.view);

  return (
    <section>
      <h2>{t('accTitle')}</h2>
      <p className="muted">{t('accIntro')}</p>
      <nav className="tabs" aria-label={t('accTitle')}>
        <button type="button" className={sub === 'dashboard' ? 'active' : ''} aria-current={sub === 'dashboard' ? 'page' : undefined} onClick={() => setSub('dashboard')}>
          {t('accTabDashboard')}
        </button>
        {canSeeOfficers && (
          <button type="button" className={sub === 'officers' ? 'active' : ''} aria-current={sub === 'officers' ? 'page' : undefined} onClick={() => setSub('officers')}>
            {t('accTabOfficers')}
          </button>
        )}
        {canSeeNotices && (
          <button type="button" className={sub === 'notices' ? 'active' : ''} aria-current={sub === 'notices' ? 'page' : undefined} onClick={() => setSub('notices')}>
            {t('accTabNotices')}
          </button>
        )}
        {canSeePulls && (
          <button type="button" className={sub === 'pulls' ? 'active' : ''} aria-current={sub === 'pulls' ? 'page' : undefined} onClick={() => setSub('pulls')}>
            {t('accTabPulls')}
          </button>
        )}
      </nav>
      {sub === 'dashboard' && <DashboardTab nodeId={nodeId} />}
      {sub === 'officers' && canSeeOfficers && <OfficersTab nodeId={nodeId} />}
      {sub === 'notices' && canSeeNotices && <NoticesTab nodeId={nodeId} caps={caps} myUserId={myUserId} />}
      {sub === 'pulls' && canSeePulls && <PullsTab nodeId={nodeId} caps={caps} />}
    </section>
  );
}

function DashboardTab({ nodeId }: { nodeId: string }) {
  const { t, locale } = useT();
  const rows = useAsync(() => get<{ rows: ProcessMetricRow[] }>(`/api/v1/accountability/dashboard?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  return (
    <div className="card">
      <p className="muted">{t('accDashboardIntro')}</p>
      {rows.loading && <p>{t('loading')}</p>}
      <ErrorBox error={rows.error} onRetry={rows.reload} />
      {rows.data && (rows.data.rows.length === 0 ? (
        <p className="muted">{t('accNoMetrics')}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>{t('accMetricDate')}</th>
              <th>{t('accDept')}</th>
              <th>{t('accFiled')}</th>
              <th>{t('accResolved')}</th>
              <th>{t('accClosed')}</th>
              <th>{t('accReopened')}</th>
              <th>{t('accEscalated')}</th>
              <th>{t('accSlaMet')}</th>
              <th>{t('accSlaBreached')}</th>
              <th>{t('accAvgResolution')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.data.rows.map((r, i) => (
              <tr key={i}>
                <td>{new Date(r.metricDate).toLocaleDateString(locale)}</td>
                <td>{r.entityId ? (locale === 'hi' ? r.entityNameHi : r.entityNameEn) ?? r.entityId : t('accAllDepts')}</td>
                <td>{r.filedCount}</td>
                <td>{r.resolvedCount}</td>
                <td>{r.closedCount}</td>
                <td>{r.reopenedCount}</td>
                <td>{r.escalatedCount > 0 ? <span className="tag warn">{r.escalatedCount}</span> : r.escalatedCount}</td>
                <td>{r.slaMetCount}</td>
                <td>{r.slaBreachedCount > 0 ? <span className="tag warn">{r.slaBreachedCount}</span> : r.slaBreachedCount}</td>
                <td>{r.avgTimeToResolutionHours != null ? r.avgTimeToResolutionHours.toFixed(1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function OfficersTab({ nodeId }: { nodeId: string }) {
  const { t, locale } = useT();
  const rows = useAsync(() => get<{ rows: OfficerMetricRow[] }>(`/api/v1/accountability/officers?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  return (
    <div className="card">
      <p className="muted">{t('accOfficersIntro')}</p>
      {rows.loading && <p>{t('loading')}</p>}
      <ErrorBox error={rows.error} onRetry={rows.reload} />
      {rows.data && (rows.data.rows.length === 0 ? (
        <p className="muted">{t('accNoOfficers')}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>{t('accOfficer')}</th>
              <th>{t('accWindowDays')}</th>
              <th>{t('accAssigned')}</th>
              <th>{t('accResolved')}</th>
              <th>{t('accSlaMet')}</th>
              <th>{t('accSlaBreached')}</th>
              <th>{t('accAvgResolution')}</th>
              <th>{t('accDistinctCitizens')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.data.rows.map((r) => (
              <tr key={r.assigneeUserId}>
                <td>{r.assigneeName}</td>
                <td>{r.windowDays}</td>
                <td>{r.assignedCount}</td>
                <td>{r.resolvedCount}</td>
                <td>{r.slaMetCount}</td>
                <td>{r.slaBreachedCount > 0 ? <span className="tag warn">{r.slaBreachedCount}</span> : r.slaBreachedCount}</td>
                <td>{r.avgTimeToResolutionHours != null ? r.avgTimeToResolutionHours.toFixed(1) : '—'}</td>
                <td>{r.distinctCitizens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function NoticesTab({ nodeId, caps, myUserId }: { nodeId: string; caps: Capabilities; myUserId: string }) {
  const { t, locale } = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const canCreate = Boolean(caps['accountability.notices']?.create);
  const notices = useAsync(() => get<{ notices: NoticeListItem[] }>(`/api/v1/accountability/notices?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);

  if (selected) return <NoticeDetailView id={selected} caps={caps} myUserId={myUserId} onBack={() => setSelected(null)} onChanged={() => notices.reload()} />;

  return (
    <div className="card">
      <p className="muted">{t('accNoticesIntro')}</p>
      {canCreate && <IssueNoticeForm nodeId={nodeId} onIssued={() => notices.reload()} />}
      {notices.loading && <p>{t('loading')}</p>}
      <ErrorBox error={notices.error} onRetry={notices.reload} />
      {notices.data && (notices.data.notices.length === 0 ? (
        <p className="muted">{t('accNoNotices')}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>{t('accOfficer')}</th>
              <th>{t('accMetricRef')}</th>
              <th>{t('accIssuedAt')}</th>
              <th>{t('accReplyDueAt')}</th>
              <th>{t('accReviewStatus')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {notices.data.notices.map((n) => (
              <tr key={n.id}>
                <td>{n.assigneeName}</td>
                <td>{n.metricRef}</td>
                <td>{new Date(n.issuedAt).toLocaleString(locale)}</td>
                <td>{new Date(n.replyDueAt).toLocaleString(locale)}</td>
                <td>{t(`accReviewStatus_${n.reviewStatus}` as TKey)}</td>
                <td className="actions">
                  <button type="button" className="secondary small" onClick={() => setSelected(n.id)}>
                    {t('viewDetail')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function IssueNoticeForm({ nodeId, onIssued }: { nodeId: string; onIssued: () => void }) {
  const { t } = useT();
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [metricRef, setMetricRef] = useState('');
  const [allegationSummary, setAllegationSummary] = useState('');
  const [replyWindowDays, setReplyWindowDays] = useState('');
  const issue = useAction(async () => {
    await post('/api/v1/accountability/notices', {
      assigneeUserId, nodeId, metricRef, allegationSummary,
      ...(replyWindowDays ? { replyWindowDays: Number(replyWindowDays) } : {})
    });
    setAssigneeUserId('');
    setMetricRef('');
    setAllegationSummary('');
    setReplyWindowDays('');
    onIssued();
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void issue.run();
  };
  return (
    <form onSubmit={onSubmit} className="card">
      <h3>{t('accIssueNotice')}</h3>
      <ErrorBox error={issue.error} />
      <Field label={t('accAssigneeUserId')}>
        <input required value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)} />
      </Field>
      <Field label={t('accMetricRef')}>
        <input required value={metricRef} onChange={(e) => setMetricRef(e.target.value)} />
      </Field>
      <Field label={t('accAllegationSummary')}>
        <textarea required value={allegationSummary} onChange={(e) => setAllegationSummary(e.target.value)} />
      </Field>
      <Field label={t('accReplyWindowDays')}>
        <input type="number" min={1} max={60} value={replyWindowDays} onChange={(e) => setReplyWindowDays(e.target.value)} />
      </Field>
      <button type="submit" disabled={issue.busy || !assigneeUserId || !metricRef || !allegationSummary}>
        {t('accIssueNotice')}
      </button>
    </form>
  );
}

function NoticeDetailView({
  id, caps, myUserId, onBack, onChanged
}: { id: string; caps: Capabilities; myUserId: string; onBack: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const [replyText, setReplyText] = useState('');
  const [verdict, setVerdict] = useState<'UPHELD' | 'DISMISSED'>('UPHELD');
  const [reviewNote, setReviewNote] = useState('');
  const [appealNote, setAppealNote] = useState('');
  const notice = useAsync(() => get<NoticeDetail>(`/api/v1/accountability/notices/${id}`, locale), [id, locale]);

  const reply = useAction(async () => {
    await post(`/api/v1/accountability/notices/${id}/reply`, { replyText });
    setReplyText('');
    notice.reload();
    onChanged();
  });
  const review = useAction(async () => {
    await post(`/api/v1/accountability/notices/${id}/review`, { verdict, note: reviewNote || undefined });
    setReviewNote('');
    notice.reload();
    onChanged();
  });
  const appeal = useAction(async () => {
    await post(`/api/v1/accountability/notices/${id}/appeal`, { appealNote });
    setAppealNote('');
    notice.reload();
    onChanged();
  });

  const n = notice.data;
  const isMine = n && n.assigneeUserId === myUserId;
  const canReview = Boolean(caps['accountability.notices']?.approve);

  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← {t('back')}
      </button>
      {notice.loading && <p>{t('loading')}</p>}
      <ErrorBox error={notice.error ?? reply.error ?? review.error ?? appeal.error} onRetry={notice.reload} />
      {n && (
        <div className="card">
          <h3>{t('accNoticeDetail')}</h3>
          <dl>
            <dt>{t('accOfficer')}</dt>
            <dd>{n.assigneeName}</dd>
            <dt>{t('accMetricRef')}</dt>
            <dd>{n.metricRef}</dd>
            <dt>{t('accAllegationSummary')}</dt>
            <dd>{n.allegationSummary}</dd>
            <dt>{t('accReviewStatus')}</dt>
            <dd>{t(`accReviewStatus_${n.reviewStatus}` as TKey)}</dd>
            <dt>{t('accReplyDueAt')}</dt>
            <dd>{new Date(n.replyDueAt).toLocaleString(locale)}</dd>
            {n.replyText && (
              <>
                <dt>{t('accReplyText')}</dt>
                <dd>{n.replyText}</dd>
              </>
            )}
            {n.reviewNote && (
              <>
                <dt>{t('accReviewNote')}</dt>
                <dd>{n.reviewNote}</dd>
              </>
            )}
            {n.appealNote && (
              <>
                <dt>{t('accAppealNote')}</dt>
                <dd>{n.appealNote}</dd>
              </>
            )}
          </dl>

          {isMine && n.reviewStatus === 'PENDING_REPLY' && (
            <form onSubmit={(e) => { e.preventDefault(); void reply.run(); }} className="row">
              <Field label={t('accReplyText')}>
                <textarea required value={replyText} onChange={(e) => setReplyText(e.target.value)} />
              </Field>
              <button type="submit" disabled={reply.busy || !replyText}>
                {t('accSubmitReply')}
              </button>
            </form>
          )}

          {canReview && n.reviewStatus === 'UNDER_REVIEW' && (
            <form onSubmit={(e) => { e.preventDefault(); void review.run(); }} className="row">
              <Field label={t('accReviewVerdict')}>
                <select value={verdict} onChange={(e) => setVerdict(e.target.value as 'UPHELD' | 'DISMISSED')}>
                  <option value="UPHELD">{t('accReviewStatus_UPHELD')}</option>
                  <option value="DISMISSED">{t('accReviewStatus_DISMISSED')}</option>
                </select>
              </Field>
              <Field label={t('accReviewNote')}>
                <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
              </Field>
              <button type="submit" disabled={review.busy}>
                {t('accSubmitReview')}
              </button>
            </form>
          )}

          {isMine && n.reviewStatus === 'UPHELD' && (
            <form onSubmit={(e) => { e.preventDefault(); void appeal.run(); }} className="row">
              <Field label={t('accAppealNote')}>
                <textarea required value={appealNote} onChange={(e) => setAppealNote(e.target.value)} />
              </Field>
              <button type="submit" disabled={appeal.busy || !appealNote}>
                {t('accSubmitAppeal')}
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

const PULL_REASONS = ['ROUTINE_REVIEW', 'AUDIT', 'PARLIAMENTARY_QUESTION', 'INCIDENT_FOLLOWUP', 'OTHER'] as const;

function PullsTab({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const canCreate = Boolean(caps['accountability.pulls']?.create);
  const [reasonCode, setReasonCode] = useState<string>(PULL_REASONS[0]);
  const [note, setNote] = useState('');
  const pulls = useAsync(() => get<{ pulls: LeadershipPull[] }>(`/api/v1/accountability/pulls?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);

  const request = useAction(async () => {
    await post('/api/v1/accountability/pulls', { nodeId, reasonCode, note: note || undefined });
    setNote('');
    pulls.reload();
  });

  return (
    <div className="card">
      <p className="muted">{t('accPullsIntro')}</p>
      {canCreate && (
        <form onSubmit={(e) => { e.preventDefault(); void request.run(); }} className="card">
          <h3>{t('accNewPull')}</h3>
          <ErrorBox error={request.error} />
          <Field label={t('accReasonCode')}>
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {PULL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`reasonCode_${r}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('note')}>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button type="submit" disabled={request.busy}>
            {t('accRequestPull')}
          </button>
        </form>
      )}
      {pulls.loading && <p>{t('loading')}</p>}
      <ErrorBox error={pulls.error} onRetry={pulls.reload} />
      {pulls.data && (pulls.data.pulls.length === 0 ? (
        <p className="muted">{t('accNoPulls')}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>{t('accReasonCode')}</th>
              <th>{t('note')}</th>
              <th>{t('accRequestedBy')}</th>
              <th>{t('accRequestedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {pulls.data.pulls.map((p) => (
              <tr key={p.id}>
                <td>{t(`reasonCode_${p.reasonCode}` as TKey)}</td>
                <td>{p.note ?? '—'}</td>
                <td>{p.requestedBy}</td>
                <td>{new Date(p.requestedAt).toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
