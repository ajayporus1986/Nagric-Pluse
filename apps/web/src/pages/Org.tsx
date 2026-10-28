/**
 * Org directory: departments, ministries, statutory authorities, SPVs and
 * other service providers, in one ERP-style register other modules (today:
 * registry.services.entityId; later: intake/case-engine/ground-audit) can
 * point at instead of a free-text department name.
 */
import { useState, type FormEvent } from 'react';
import { del, get, post } from '../api';
import { Dialog, ErrorBox, Field, useAction, useAsync } from '../components';
import { useT } from '../i18n';
import type { Capabilities, OrgEntity } from '../types';

export function OrgPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ kind: 'DEPARTMENT', nameEn: '', nameHi: '', parentEntityId: '', contactEn: '', contactHi: '' });

  const entities = useAsync(() => get<{ entities: OrgEntity[] }>(`/api/v1/org/entities?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const canCreate = Boolean(caps['org.directory']?.create);

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await post('/api/v1/org/entities', {
      nodeId, kind: form.kind, nameEn: form.nameEn, nameHi: form.nameHi,
      ...(form.parentEntityId ? { parentEntityId: form.parentEntityId } : {}),
      ...(form.contactEn ? { contactEn: form.contactEn } : {}), ...(form.contactHi ? { contactHi: form.contactHi } : {})
    });
    setForm({ kind: 'DEPARTMENT', nameEn: '', nameHi: '', parentEntityId: '', contactEn: '', contactHi: '' });
    entities.reload();
    return true;
  });
  const retire = useAction(async (id: string) => {
    await del(`/api/v1/org/entities/${id}`);
    entities.reload();
  });

  const nameOf = (id: string | null) => {
    const e = entities.data?.entities.find((x) => x.id === id);
    return e ? (locale === 'hi' ? e.nameHi : e.nameEn) : t('none');
  };

  return (
    <section>
      <h2>{t('orgTitle')}</h2>
      <div className="card">
        <div className="row spread">
          <h3>{t('entities')}</h3>
          {canCreate && (
            <button type="button" onClick={() => setCreating(true)}>
              {t('createEntity')}
            </button>
          )}
        </div>
        {entities.loading && <p>{t('loading')}</p>}
        <ErrorBox error={entities.error ?? retire.error} onRetry={entities.reload} />
        <table className="list">
          <thead>
            <tr>
              <th>{t('entityName')}</th>
              <th>{t('entityKind')}</th>
              <th>{t('parentEntity')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entities.data?.entities.map((o) => (
              <tr key={o.id}>
                <td>{locale === 'hi' ? o.nameHi : o.nameEn}</td>
                <td className="mono">{o.kind}</td>
                <td>{nameOf(o.parentEntityId)}</td>
                <td className="actions">
                  {canCreate && (
                    <button type="button" className="danger small" disabled={retire.busy} onClick={() => void retire.run(o.id)}>
                      {t('retire')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <Dialog open={creating} title={t('createEntity')} onClose={() => setCreating(false)}>
          <form onSubmit={(e) => void create.run(e).then((ok) => ok && setCreating(false))}>
            <Field label={t('entityKind')}>
              <input required pattern="[A-Z][A-Z0-9_]{1,60}" placeholder="DEPARTMENT" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value.toUpperCase() })} />
            </Field>
            <Field label={`${t('entityName')} (English)`}>
              <input required maxLength={300} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            </Field>
            <Field label={`${t('entityName')} (हिन्दी)`}>
              <input required maxLength={300} value={form.nameHi} onChange={(e) => setForm({ ...form, nameHi: e.target.value })} />
            </Field>
            <Field label={t('parentEntity')}>
              <select value={form.parentEntityId} onChange={(e) => setForm({ ...form, parentEntityId: e.target.value })}>
                <option value="">{t('none')}</option>
                {entities.data?.entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {locale === 'hi' ? e.nameHi : e.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('contact')}>
              <input maxLength={500} value={form.contactEn} onChange={(e) => setForm({ ...form, contactEn: e.target.value })} />
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
      </div>
    </section>
  );
}
