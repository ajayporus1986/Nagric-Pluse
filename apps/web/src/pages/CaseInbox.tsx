/**
 * Responder inbox (Phase 3 — case engine): grievances currently assigned to
 * the signed-in staff member, and unassigned grievances in the selected
 * area, both sorted by escalation level then SLA due date so the most
 * urgent work surfaces first. Assignment itself (assign-to-me, reassign) and
 * the assignment history for one grievance live here too; the escalation
 * sweep and the citizen closure-confirmation flow are server-side (worker
 * jobs / public API) and have no UI of their own.
 */
import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { ErrorBox, Field, useAction, useAsync } from '../components';
import { useT, type TKey } from '../i18n';
import type { Capabilities, CaseAssignment, CaseInbox, CaseInboxItem } from '../types';

export function CaseInboxPage({ nodeId, caps, myUserId }: { nodeId: string; caps: Capabilities; myUserId: string }) {
  const { t, locale } = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const canAssign = Boolean(caps['case.assignments']?.update);

  const inbox = useAsync(() => get<CaseInbox>(`/api/v1/case/inbox?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);

  if (selected)
    return (
      <CaseDetailView
        id={selected}
        myUserId={myUserId}
        canAssign={canAssign}
        onBack={() => setSelected(null)}
        onChanged={() => inbox.reload()}
      />
    );

  return (
    <section>
      <h2>{t('caseInboxTitle')}</h2>
      <p className="muted">{t('caseInboxIntro')}</p>
      {inbox.loading && <p>{t('loading')}</p>}
      <ErrorBox error={inbox.error} onRetry={inbox.reload} />
      {inbox.data && (
        <>
          <div className="card">
            <h3>{t('caseMine')}</h3>
            {inbox.data.mine.length === 0 ? (
              <p className="muted">{t('caseNoneMine')}</p>
            ) : (
              <CaseTable items={inbox.data.mine} onSelect={setSelected} />
            )}
          </div>
          <div className="card">
            <h3>{t('caseUnassigned')}</h3>
            {inbox.data.unassigned.length === 0 ? (
              <p className="muted">{t('caseNoneUnassigned')}</p>
            ) : (
              <CaseTable items={inbox.data.unassigned} onSelect={setSelected} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CaseTable({ items, onSelect }: { items: CaseInboxItem[]; onSelect: (id: string) => void }) {
  const { t, locale } = useT();
  return (
    <table className="list">
      <thead>
        <tr>
          <th>{t('referenceCode')}</th>
          <th>{t('subject')}</th>
          <th>{t('status')}</th>
          <th>{t('escalationLevel')}</th>
          <th>{t('slaDue')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((g) => (
          <tr key={g.id}>
            <td className="mono">{g.referenceCode}</td>
            <td>{g.subject}</td>
            <td>{t(`status_${g.status}` as TKey)}</td>
            <td>{g.escalationLevel > 0 ? <span className="tag warn">{g.escalationLevel}</span> : '—'}</td>
            <td>{g.slaDueAt ? new Date(g.slaDueAt).toLocaleDateString(locale) : '—'}</td>
            <td className="actions">
              <button type="button" className="secondary small" onClick={() => onSelect(g.id)}>
                {t('viewDetail')}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaseDetailView({
  id,
  myUserId,
  canAssign,
  onBack,
  onChanged
}: {
  id: string;
  myUserId: string;
  canAssign: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useT();
  const [assigneeId, setAssigneeId] = useState('');
  const assignment = useAsync(() => get<CaseAssignment>(`/api/v1/case/assignments/${id}`, locale), [id, locale]);

  const assign = useAction(async (toUserId: string) => {
    await post('/api/v1/case/assignments', { grievanceId: id, assigneeUserId: toUserId });
    setAssigneeId('');
    assignment.reload();
    onChanged();
  });

  const onReassignSubmit = (e: FormEvent) => {
    e.preventDefault();
    void assign.run(assigneeId);
  };

  const a = assignment.data;

  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← {t('back')}
      </button>
      {assignment.loading && <p>{t('loading')}</p>}
      <ErrorBox error={assignment.error ?? assign.error} onRetry={assignment.reload} />
      {a && (
        <div className="card">
          <h3>{t('currentAssignment')}</h3>
          <p>{a.current ? `${t('assignedTo')}: ${a.current}` : t('unassignedLabel')}</p>

          {canAssign && (
            <div className="row">
              {a.current !== myUserId && (
                <button type="button" disabled={assign.busy} onClick={() => void assign.run(myUserId)}>
                  {t('assignToMe')}
                </button>
              )}
              <form onSubmit={onReassignSubmit} className="row">
                <Field label={t('chooseAssignee')}>
                  <input required value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} />
                </Field>
                <button type="submit" disabled={assign.busy || !assigneeId}>
                  {t('reassign')}
                </button>
              </form>
            </div>
          )}

          <h3>{t('assignmentHistory')}</h3>
          {a.history.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>{t('assigneeLabel')}</th>
                  <th>{t('filedOn')}</th>
                  <th>{t('unassignedAtLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {a.history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.assigneeName}</td>
                    <td>{new Date(h.assignedAt).toLocaleString(locale)}</td>
                    <td>{h.unassignedAt ? new Date(h.unassignedAt).toLocaleString(locale) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
