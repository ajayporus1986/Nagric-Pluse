/**
 * Staff accounts: list, create (one-time password shown once), disable now,
 * and propose role grants/removals, re-enable and credential resets (quorum).
 */
import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { Dialog, ErrorBox, Field, Pill, useAction, useAsync } from '../components';
import { useT } from '../i18n';
import type { Capabilities, RoleInfo, StaffUser } from '../types';
import { ProposeDialog, type Proposal } from './Propose';

export function UsersPage({ nodeId, nodeLevel, caps, myUserId }: { nodeId: string; nodeLevel: string; caps: Capabilities; myUserId: string }) {
  const { t, locale } = useT();
  const users = useAsync(() => get<{ users: StaffUser[] }>(`/api/v1/users?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const roles = useAsync(() => get<{ roles: RoleInfo[] }>('/api/v1/roles', locale), [locale]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ username: string; oneTimePassword: string } | null>(null);
  const [grantFor, setGrantFor] = useState<StaffUser | null>(null);
  const [grantRole, setGrantRole] = useState('');
  const [disableFor, setDisableFor] = useState<StaffUser | null>(null);
  const [disableReason, setDisableReason] = useState('');
  const [form, setForm] = useState({ username: '', displayName: '', email: '' });
  const canCreate = Boolean(caps['iam.users']?.create);
  const canUpdate = Boolean(caps['iam.users']?.update);
  const canPropose = Boolean(caps['platform.change_requests']?.create);
  const roleName = (code: string) => {
    const r = roles.data?.roles.find((x) => x.code === code);
    return r ? (locale === 'hi' ? r.nameHi : r.nameEn) : code;
  };
  /** True if the account holds any oversight role: such accounts are disabled only by quorum. */
  const holdsSensitive = (u: StaffUser) => u.roles.some((r) => roles.data?.roles.find((x) => x.code === r.role)?.sensitive);
  // Only roles assignable at this area's level are offered.
  const assignable = roles.data?.roles.filter((r) => r.levels.includes(nodeLevel)) ?? [];

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<{ username: string; oneTimePassword: string }>(
      '/api/v1/users',
      { nodeId, username: form.username, displayName: form.displayName, ...(form.email ? { email: form.email } : {}) },
      locale
    );
    setCreated(r);
    setForm({ username: '', displayName: '', email: '' });
    users.reload();
    return true;
  });
  const disable = useAction(async (e: FormEvent) => {
    e.preventDefault();
    if (!disableFor) return;
    await post(`/api/v1/users/${disableFor.id}/disable`, { nodeId, reason: disableReason }, locale);
    setDisableFor(null);
    setDisableReason('');
    users.reload();
  });

  return (
    <section>
      <div className="row spread">
        <h2>{t('usersTitle')}</h2>
        {canCreate && (
          <button type="button" data-testid="create-user" onClick={() => setCreating(true)}>
            {t('createUser')}
          </button>
        )}
      </div>
      {created && (
        <div className="card warn" role="status">
          {created.username}: {t('newPasswordOnce')} <code data-testid="otp">{created.oneTimePassword}</code>
          <button type="button" className="link" onClick={() => setCreated(null)}>
            {t('close')}
          </button>
        </div>
      )}
      {users.loading && <p>{t('loading')}</p>}
      <ErrorBox error={users.error} onRetry={users.reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('username')}</th>
            <th>{t('displayName')}</th>
            <th>{t('status')}</th>
            <th>{t('roles')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data?.users.map((u) => (
            <tr key={u.id} data-user={u.username}>
              <td className="mono">{u.username}</td>
              <td>{u.displayName}</td>
              <td>
                {u.status === 'ACTIVE' ? <Pill tone="ok">{t('accountActive')}</Pill> : <Pill tone="off">{t('accountDisabled')}</Pill>}{' '}
                {u.totpEnrolled ? <Pill tone="info">{t('mfaReady')}</Pill> : <Pill tone="warn">{t('mfaMissing')}</Pill>}
              </td>
              <td>
                {u.roles.map((r) => (
                  <div key={r.assignmentId}>
                    {roleName(r.role)} <span className="muted">@ {r.nodeId}</span>
                    {canPropose && u.id !== myUserId && r.nodeId === nodeId && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => setProposal({ title: `${t('revokeRole')}: ${u.username} · ${roleName(r.role)}`, nodeId, kind: 'ROLE_REVOKE', payload: { assignmentId: r.assignmentId } })}
                      >
                        {t('revokeRole')}
                      </button>
                    )}
                  </div>
                ))}
              </td>
              <td className="actions">
                {u.id !== myUserId && canPropose && (
                  <button type="button" data-testid="grant-role" className="secondary small" onClick={() => setGrantFor(u)}>
                    {t('grantRole')}
                  </button>
                )}
                {u.id !== myUserId && canPropose && u.status === 'ACTIVE' && holdsSensitive(u) && (
                  <button type="button" className="danger small" onClick={() => setProposal({ title: `${t('proposeDisable')}: ${u.username}`, nodeId, kind: 'USER_DISABLE', payload: { userId: u.id } })}>
                    {t('proposeDisable')}
                  </button>
                )}
                {u.id !== myUserId && canUpdate && u.status === 'ACTIVE' && !holdsSensitive(u) && (
                  <button type="button" className="danger small" onClick={() => setDisableFor(u)}>
                    {t('disable')}
                  </button>
                )}
                {u.id !== myUserId && canPropose && u.status === 'DISABLED' && (
                  <button type="button" className="secondary small" onClick={() => setProposal({ title: `${t('enable')}: ${u.username}`, nodeId, kind: 'USER_ENABLE', payload: { userId: u.id } })}>
                    {t('enable')}
                  </button>
                )}
                {u.id !== myUserId && canPropose && (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => setProposal({ title: `${t('resetCredentials')}: ${u.username}`, nodeId, kind: 'USER_RESET_CREDENTIALS', payload: { userId: u.id } })}
                  >
                    {t('resetCredentials')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog open={creating} title={t('createUser')} onClose={() => setCreating(false)}>
        <form
          onSubmit={(e) => {
            // Close only on success; on failure the dialog stays open showing the error.
            void create.run(e).then((ok) => ok && setCreating(false));
          }}
        >
          <Field label={t('username')}>
            <input name="username" required pattern="[a-zA-Z0-9._\-]{3,64}" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label={t('displayName')}>
            <input name="displayName" required maxLength={200} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </Field>
          <Field label={t('email')}>
            <input name="email" type="email" maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <ErrorBox error={create.error} />
          <div className="row">
            <button type="submit" disabled={create.busy}>
              {t('submit')}
            </button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={grantFor !== null} title={`${t('grantRole')}: ${grantFor?.username ?? ''}`} onClose={() => setGrantFor(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!grantFor || !grantRole) return;
            setProposal({ title: `${t('grantRole')}: ${grantFor.username} · ${roleName(grantRole)}`, nodeId, kind: 'ROLE_GRANT', payload: { userId: grantFor.id, role: grantRole } });
            setGrantFor(null);
            setGrantRole('');
          }}
        >
          <Field label={t('role')}>
            <select name="role" required value={grantRole} onChange={(e) => setGrantRole(e.target.value)}>
              <option value="" />
              {assignable.map((r) => (
                <option key={r.code} value={r.code}>
                  {locale === 'hi' ? r.nameHi : r.nameEn}
                  {r.sensitive ? ' ★' : ''}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <button type="submit">{t('proposeChange')}</button>
            <button type="button" className="secondary" onClick={() => setGrantFor(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={disableFor !== null} title={`${t('disable')}: ${disableFor?.username ?? ''}`} onClose={() => setDisableFor(null)}>
        <form onSubmit={(e) => void disable.run(e)}>
          <Field label={t('reason')}>
            <textarea name="reason" required minLength={10} maxLength={2000} value={disableReason} onChange={(e) => setDisableReason(e.target.value)} />
          </Field>
          <ErrorBox error={disable.error} />
          <div className="row">
            <button type="submit" className="danger" disabled={disable.busy}>
              {t('disable')}
            </button>
            <button type="button" className="secondary" onClick={() => setDisableFor(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </Dialog>

      <ProposeDialog
        proposal={proposal}
        onClose={(submitted) => {
          setProposal(null);
          if (submitted) users.reload();
        }}
      />
    </section>
  );
}
