/**
 * Grievance intake: citizen/business grievances filed against a notified
 * service or org entity (or a plain civic complaint), with status, statutory
 * SLA due date, and -- when the complainant reported it -- whether they had
 * to pay, hire an agent or use influence, and why. Filing itself happens
 * outside this console (citizen-facing, public API); staff use this tab to
 * list, inspect and move a grievance through its status.
 */
import { useState, type FormEvent } from 'react';
import { get, patch } from '../api';
import { ErrorBox, Field, useAction, useAsync } from '../components';
import { useT, type TKey } from '../i18n';
import type { Capabilities, GrievanceDetail, GrievanceListItem } from '../types';

const STATUSES = ['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED', 'CLOSED'] as const;

// Known seeded values of the admin-addable `grievanceSubtype` classification
// axis; a district can add more through the Classification tab, so this is a
// label lookup with a raw-code fallback, not a closed enum.
const SUBTYPE_LABELS: Record<string, { en: string; hi: string }> = {
  STANDARD: { en: 'Standard', hi: 'सामान्य' },
  ENFORCEMENT_EVICTION: { en: 'Enforcement / eviction action', hi: 'प्रवर्तन / बेदखली कार्रवाई' }
};
function subtypeLabel(code: string, locale: 'en' | 'hi'): string {
  return SUBTYPE_LABELS[code]?.[locale] ?? code;
}
const TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ['ACKNOWLEDGED', 'REJECTED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'REJECTED'],
  IN_PROGRESS: ['RESOLVED', 'REJECTED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  REJECTED: ['CLOSED'],
  CLOSED: []
};

export function GrievancesPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const canTriage = Boolean(caps['intake.grievances']?.update);

  const list = useAsync(
    () => get<{ grievances: GrievanceListItem[] }>(`/api/v1/intake/grievances?nodeId=${encodeURIComponent(nodeId)}${statusFilter ? `&status=${statusFilter}` : ''}`, locale),
    [nodeId, locale, statusFilter]
  );

  if (selected) return <GrievanceDetailView id={selected} canTriage={canTriage} onBack={() => setSelected(null)} onChanged={() => list.reload()} />;

  return (
    <section>
      <h2>{t('intakeTitle')}</h2>
      <p className="muted">{t('intakeIntro')}</p>
      <div className="card">
        <div className="row">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t('filterAll')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status_${s}` as TKey)}
              </option>
            ))}
          </select>
        </div>
        {list.loading && <p>{t('loading')}</p>}
        <ErrorBox error={list.error} onRetry={list.reload} />
        {!list.loading && list.data?.grievances.length === 0 && <p className="muted">{t('noGrievances')}</p>}
        {list.data && list.data.grievances.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th>{t('referenceCode')}</th>
                <th>{t('subject')}</th>
                <th>{t('complainantType')}</th>
                <th>{t('grievanceSubtype')}</th>
                <th>{t('status')}</th>
                <th>{t('slaDue')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.grievances.map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.referenceCode}</td>
                  <td>
                    {g.subject} {g.hasFriction && <span className="tag warn" title={t('frictionFlag')}>⚠</span>}
                  </td>
                  <td>{t(`complainant_${g.complainantType}` as TKey)}</td>
                  <td>{g.subtype === 'STANDARD' ? '—' : subtypeLabel(g.subtype, locale)}</td>
                  <td>{t(`status_${g.status}` as TKey)}</td>
                  <td>{g.slaDueAt ? new Date(g.slaDueAt).toLocaleDateString(locale) : '—'}</td>
                  <td className="actions">
                    <button type="button" className="secondary small" onClick={() => setSelected(g.id)}>
                      {t('viewDetail')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function GrievanceDetailView({ id, canTriage, onBack, onChanged }: { id: string; canTriage: boolean; onBack: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const [toStatus, setToStatus] = useState('');
  const [note, setNote] = useState('');
  const detail = useAsync(() => get<GrievanceDetail>(`/api/v1/intake/grievances/${id}`, locale), [id, locale]);

  const change = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await patch(`/api/v1/intake/grievances/${id}/status`, { toStatus, note: note || undefined });
    setToStatus('');
    setNote('');
    detail.reload();
    onChanged();
  });

  const g = detail.data;
  const allowedNext = g ? (TRANSITIONS[g.status] ?? []) : [];

  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← {t('back')}
      </button>
      {detail.loading && <p>{t('loading')}</p>}
      <ErrorBox error={detail.error ?? change.error} onRetry={detail.reload} />
      {g && (
        <div className="card">
          <h2>
            {g.subject} <span className="mono muted">{g.referenceCode}</span>
          </h2>
          <p>
            <strong>{t('status')}:</strong> {t(`status_${g.status}` as TKey)} &nbsp;·&nbsp;
            <strong>{t('complainantType')}:</strong> {t(`complainant_${g.complainantType}` as TKey)} &nbsp;·&nbsp;
            {g.subtype !== 'STANDARD' && (
              <>
                <strong>{t('grievanceSubtype')}:</strong> {subtypeLabel(g.subtype, locale)} &nbsp;·&nbsp;
              </>
            )}
            <strong>{t('filedOn')}:</strong> {new Date(g.createdAt).toLocaleString(locale)}
            {g.slaDueAt && (
              <>
                {' '}
                &nbsp;·&nbsp; <strong>{t('slaDue')}:</strong> {new Date(g.slaDueAt).toLocaleDateString(locale)}
              </>
            )}
          </p>
          <p>
            <strong>{t('description')}:</strong> {g.description}
          </p>

          {g.frictionReport && (
            <div className="card narrow">
              <h3>{t('frictionReport')}</h3>
              <p>
                {t('frictionOccurred')}: {g.frictionReport.occurred ? '✓' : '—'}
              </p>
              {g.frictionReport.reasonCodes?.length > 0 && (
                <p>
                  {t('frictionReasons')}: {g.frictionReport.reasonCodes.join(', ')}
                </p>
              )}
              {g.frictionReport.otherText && (
                <p>
                  {t('frictionOther')}: {g.frictionReport.otherText}
                </p>
              )}
            </div>
          )}

          {g.businessProfile && (
            <div className="card narrow">
              <h3>{t('businessProfile')}</h3>
              <pre className="mono small">{JSON.stringify(g.businessProfile, null, 2)}</pre>
            </div>
          )}

          {g.departments.length > 0 && (
            <div className="card narrow">
              <h3>{t('responsibleDepartments')}</h3>
              <ul className="plain">
                {g.departments.map((d) => (
                  <li key={d.entityId}>
                    {locale === 'hi' ? d.nameHi : d.nameEn} {d.isPrimary && <span className="tag">{t('primary')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>{t('history')}</h3>
          <table className="list">
            <thead>
              <tr>
                <th>{t('filedOn')}</th>
                <th>{t('status')}</th>
                <th>{t('note')}</th>
              </tr>
            </thead>
            <tbody>
              {g.events.map((ev) => (
                <tr key={ev.id}>
                  <td>{new Date(ev.createdAt).toLocaleString(locale)}</td>
                  <td>
                    {ev.fromStatus ? `${t(`status_${ev.fromStatus}` as TKey)} → ` : ''}
                    {t(`status_${ev.toStatus}` as TKey)}
                  </td>
                  <td>{ev.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {canTriage && allowedNext.length > 0 && (
            <form onSubmit={(e) => void change.run(e)} className="row">
              <Field label={t('changeStatus')}>
                <select required value={toStatus} onChange={(e) => setToStatus(e.target.value)}>
                  <option value="">—</option>
                  {allowedNext.map((s) => (
                    <option key={s} value={s}>
                      {t(`status_${s}` as TKey)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('note')}>
                <input maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button type="submit" disabled={change.busy || !toStatus}>
                {t('submit')}
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
