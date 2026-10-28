/**
 * Offices, posts (and their current holders), and the services notified
 * under a right-to-public-service law. Everything here is a direct, audited
 * edit except a service's time limit (SLA): that always goes through the
 * "Propose new time limit" button, which opens the same change-request
 * dialog used everywhere else in the console, because the server refuses a
 * direct edit of that one field (see registry/routes.ts on the API side).
 */
import { useState, type FormEvent } from 'react';
import { del, get, post } from '../api';
import { Dialog, ErrorBox, Field, useAction, useAsync } from '../components';
import { useT } from '../i18n';
import type { Capabilities, NotifiedService, Office, OrgEntity, Post } from '../types';
import { ProposeDialog, type Proposal } from './Propose';

export function RegistryPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const [selectedOffice, setSelectedOffice] = useState<Office | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  const offices = useAsync(() => get<{ offices: Office[] }>(`/api/v1/registry/offices?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const services = useAsync(() => get<{ services: NotifiedService[] }>(`/api/v1/registry/services?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const posts = useAsync(
    () => (selectedOffice ? get<{ posts: Post[] }>(`/api/v1/registry/posts?officeId=${encodeURIComponent(selectedOffice.id)}`, locale) : Promise.resolve({ posts: [] })),
    [selectedOffice, locale]
  );

  const canOffices = Boolean(caps['registry.offices']?.create);
  const canPosts = Boolean(caps['registry.posts']?.create);
  const canServices = Boolean(caps['registry.services']?.create);
  const canPropose = Boolean(caps['platform.change_requests']?.create);

  const postTitleOf = (postId: string | null, allPosts: Post[] | undefined) => {
    const p = allPosts?.find((x) => x.id === postId);
    return p ? (locale === 'hi' ? p.titleHi : p.titleEn) : t('none');
  };

  return (
    <section>
      <h2>{t('registryTitle')}</h2>

      <OfficesSection nodeId={nodeId} canCreate={canOffices} offices={offices} selected={selectedOffice} onSelect={setSelectedOffice} />

      {selectedOffice && (
        <PostsSection
          office={selectedOffice}
          canCreate={canPosts}
          posts={posts}
          onChanged={() => {
            posts.reload();
            offices.reload();
          }}
        />
      )}

      <ServicesSection
        nodeId={nodeId}
        canCreate={canServices}
        canPropose={canPropose}
        services={services}
        postNameOf={(id) => postTitleOf(id, posts.data?.posts)}
        onPropose={setProposal}
      />

      <ProposeDialog proposal={proposal} onClose={() => { setProposal(null); services.reload(); }} />
    </section>
  );
}

// ===== Offices ===============================================================

function OfficesSection({
  nodeId, canCreate, offices, selected, onSelect
}: {
  nodeId: string;
  canCreate: boolean;
  offices: ReturnType<typeof useAsync<{ offices: Office[] }>>;
  selected: Office | null;
  onSelect: (o: Office | null) => void;
}) {
  const { t, locale } = useT();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ nameEn: '', nameHi: '', departmentEn: '', departmentHi: '', addressEn: '', addressHi: '', phone: '' });

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await post('/api/v1/registry/offices', {
      nodeId, nameEn: form.nameEn, nameHi: form.nameHi, departmentEn: form.departmentEn, departmentHi: form.departmentHi,
      ...(form.addressEn ? { addressEn: form.addressEn } : {}), ...(form.addressHi ? { addressHi: form.addressHi } : {}), ...(form.phone ? { phone: form.phone } : {})
    });
    setForm({ nameEn: '', nameHi: '', departmentEn: '', departmentHi: '', addressEn: '', addressHi: '', phone: '' });
    offices.reload();
    return true;
  });
  const retire = useAction(async (id: string) => {
    await del(`/api/v1/registry/offices/${id}`);
    if (selected?.id === id) onSelect(null);
    offices.reload();
  });

  return (
    <div className="card">
      <div className="row spread">
        <h3>{t('offices')}</h3>
        {canCreate && (
          <button type="button" onClick={() => setCreating(true)}>
            {t('createOffice')}
          </button>
        )}
      </div>
      {offices.loading && <p>{t('loading')}</p>}
      <ErrorBox error={offices.error ?? retire.error} onRetry={offices.reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('office')}</th>
            <th>{t('department')}</th>
            <th>{t('phone')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {offices.data?.offices.map((o) => (
            <tr key={o.id} className={selected?.id === o.id ? 'active' : ''}>
              <td>
                <button type="button" className="link" onClick={() => onSelect(o)}>
                  {locale === 'hi' ? o.nameHi : o.nameEn}
                </button>
              </td>
              <td>{locale === 'hi' ? o.departmentHi : o.departmentEn}</td>
              <td className="mono">{o.phone ?? ''}</td>
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

      <Dialog open={creating} title={t('createOffice')} onClose={() => setCreating(false)}>
        <form onSubmit={(e) => void create.run(e).then((ok) => ok && setCreating(false))}>
          <Field label={`${t('office')} (English)`}>
            <input required maxLength={200} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          </Field>
          <Field label={`${t('office')} (हिन्दी)`}>
            <input required maxLength={200} value={form.nameHi} onChange={(e) => setForm({ ...form, nameHi: e.target.value })} />
          </Field>
          <Field label={`${t('department')} (English)`}>
            <input required maxLength={200} value={form.departmentEn} onChange={(e) => setForm({ ...form, departmentEn: e.target.value })} />
          </Field>
          <Field label={`${t('department')} (हिन्दी)`}>
            <input required maxLength={200} value={form.departmentHi} onChange={(e) => setForm({ ...form, departmentHi: e.target.value })} />
          </Field>
          <Field label={t('address')}>
            <input maxLength={500} value={form.addressEn} onChange={(e) => setForm({ ...form, addressEn: e.target.value })} />
          </Field>
          <Field label={t('phone')}>
            <input maxLength={20} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
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
  );
}

// ===== Posts & holders ========================================================

function PostsSection({
  office, canCreate, posts, onChanged
}: {
  office: Office;
  canCreate: boolean;
  posts: ReturnType<typeof useAsync<{ posts: Post[] }>>;
  onChanged: () => void;
}) {
  const { t, locale } = useT();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ titleEn: '', titleHi: '' });
  const [assigning, setAssigning] = useState<Post | null>(null);
  const [userId, setUserId] = useState('');

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await post('/api/v1/registry/posts', { officeId: office.id, titleEn: form.titleEn, titleHi: form.titleHi });
    setForm({ titleEn: '', titleHi: '' });
    onChanged();
    return true;
  });
  const retire = useAction(async (id: string) => {
    await del(`/api/v1/registry/posts/${id}`);
    onChanged();
  });
  const assign = useAction(async (e: FormEvent) => {
    e.preventDefault();
    if (!assigning) return;
    await post(`/api/v1/registry/posts/${assigning.id}/holder`, { userId });
    setUserId('');
    onChanged();
    return true;
  });
  const endHolder = useAction(async (id: string) => {
    await post(`/api/v1/registry/posts/${id}/holder/end`);
    onChanged();
  });

  return (
    <div className="card">
      <div className="row spread">
        <h3>
          {t('posts')} · {locale === 'hi' ? office.nameHi : office.nameEn}
        </h3>
        {canCreate && (
          <button type="button" onClick={() => setCreating(true)}>
            {t('createPost')}
          </button>
        )}
      </div>
      {posts.loading && <p>{t('loading')}</p>}
      <ErrorBox error={posts.error ?? retire.error ?? endHolder.error} onRetry={posts.reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('postTitle')}</th>
            <th>{t('holder')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {posts.data?.posts.map((p) => (
            <tr key={p.id}>
              <td>{locale === 'hi' ? p.titleHi : p.titleEn}</td>
              <td>{p.holder ? (p.holder.displayName ?? p.holder.username) : <span className="muted">{t('vacant')}</span>}</td>
              <td className="actions">
                {canCreate && !p.holder && (
                  <button type="button" className="secondary small" onClick={() => setAssigning(p)}>
                    {t('assignHolder')}
                  </button>
                )}
                {canCreate && p.holder && (
                  <button type="button" className="secondary small" disabled={endHolder.busy} onClick={() => void endHolder.run(p.id)}>
                    {t('endHolder')}
                  </button>
                )}
                {canCreate && !p.holder && (
                  <button type="button" className="danger small" disabled={retire.busy} onClick={() => void retire.run(p.id)}>
                    {t('retire')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog open={creating} title={t('createPost')} onClose={() => setCreating(false)}>
        <form onSubmit={(e) => void create.run(e).then((ok) => ok && setCreating(false))}>
          <Field label={`${t('postTitle')} (English)`}>
            <input required maxLength={200} value={form.titleEn} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} />
          </Field>
          <Field label={`${t('postTitle')} (हिन्दी)`}>
            <input required maxLength={200} value={form.titleHi} onChange={(e) => setForm({ ...form, titleHi: e.target.value })} />
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

      <Dialog open={assigning !== null} title={t('assignHolder')} onClose={() => setAssigning(null)}>
        <form onSubmit={(e) => void assign.run(e).then((ok) => ok && setAssigning(null))}>
          <Field label="User id">
            <input required pattern="[0-9a-fA-F-]{36}" value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <ErrorBox error={assign.error} />
          <div className="row">
            <button type="submit" disabled={assign.busy}>
              {t('submit')}
            </button>
            <button type="button" className="secondary" onClick={() => setAssigning(null)}>
              {t('cancel')}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

// ===== Services ==============================================================

function ServicesSection({
  nodeId, canCreate, canPropose, services, postNameOf, onPropose
}: {
  nodeId: string;
  canCreate: boolean;
  canPropose: boolean;
  services: ReturnType<typeof useAsync<{ services: NotifiedService[] }>>;
  postNameOf: (id: string | null) => string;
  onPropose: (p: Proposal) => void;
}) {
  const { t, locale } = useT();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', nameEn: '', nameHi: '', departmentEn: '', departmentHi: '', slaDays: '3', entityId: '' });
  const [newSla, setNewSla] = useState<Record<string, string>>({});
  // Org directory entities (Phase 1.5): a service may optionally point at a
  // real department/authority instead of only the free-text department fields.
  const entities = useAsync(() => get<{ entities: OrgEntity[] }>(`/api/v1/org/entities?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);

  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await post('/api/v1/registry/services', {
      nodeId, code: form.code, nameEn: form.nameEn, nameHi: form.nameHi, departmentEn: form.departmentEn, departmentHi: form.departmentHi,
      slaDays: Number(form.slaDays), ...(form.entityId ? { entityId: form.entityId } : {})
    });
    setForm({ code: '', nameEn: '', nameHi: '', departmentEn: '', departmentHi: '', slaDays: '3', entityId: '' });
    services.reload();
    return true;
  });
  const retire = useAction(async (id: string) => {
    await del(`/api/v1/registry/services/${id}`);
    services.reload();
  });

  return (
    <div className="card">
      <div className="row spread">
        <h3>{t('services')}</h3>
        {canCreate && (
          <button type="button" onClick={() => setCreating(true)}>
            {t('createService')}
          </button>
        )}
      </div>
      {services.loading && <p>{t('loading')}</p>}
      <ErrorBox error={services.error ?? retire.error} onRetry={services.reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('serviceCode')}</th>
            <th>{t('serviceName')}</th>
            <th>{t('designatedOfficer')}</th>
            <th>{t('slaDays')}</th>
            <th>{t('sourceAct')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {services.data?.services.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.code}</td>
              <td>{locale === 'hi' ? s.nameHi : s.nameEn}</td>
              <td>{postNameOf(s.designatedOfficerPostId)}</td>
              <td>{s.slaDays}</td>
              <td className="muted">{locale === 'hi' ? s.sourceActHi : s.sourceActEn}</td>
              <td className="actions">
                {canPropose && (
                  <>
                    <input
                      type="number" min={1} max={365} className="small-number" placeholder={String(s.slaDays)}
                      value={newSla[s.id] ?? ''} onChange={(e) => setNewSla({ ...newSla, [s.id]: e.target.value })}
                    />
                    <button
                      type="button" className="secondary small"
                      onClick={() =>
                        onPropose({
                          title: `${t('proposeSlaChange')}: ${locale === 'hi' ? s.nameHi : s.nameEn}`,
                          nodeId, kind: 'SERVICE_SLA_SET', payload: { serviceId: s.id, slaDays: Number(newSla[s.id] || s.slaDays) }
                        })
                      }
                    >
                      {t('proposeSlaChange')}
                    </button>
                  </>
                )}
                {canCreate && (
                  <button type="button" className="danger small" disabled={retire.busy} onClick={() => void retire.run(s.id)}>
                    {t('retire')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog open={creating} title={t('createService')} onClose={() => setCreating(false)}>
        <form onSubmit={(e) => void create.run(e).then((ok) => ok && setCreating(false))}>
          <Field label={t('serviceCode')}>
            <input required pattern="[a-z][a-z0-9_]{1,60}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label={`${t('serviceName')} (English)`}>
            <input required maxLength={300} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          </Field>
          <Field label={`${t('serviceName')} (हिन्दी)`}>
            <input required maxLength={300} value={form.nameHi} onChange={(e) => setForm({ ...form, nameHi: e.target.value })} />
          </Field>
          <Field label={`${t('department')} (English)`}>
            <input required maxLength={200} value={form.departmentEn} onChange={(e) => setForm({ ...form, departmentEn: e.target.value })} />
          </Field>
          <Field label={`${t('department')} (हिन्दी)`}>
            <input required maxLength={200} value={form.departmentHi} onChange={(e) => setForm({ ...form, departmentHi: e.target.value })} />
          </Field>
          <Field label={t('slaDays')}>
            <input required type="number" min={1} max={365} value={form.slaDays} onChange={(e) => setForm({ ...form, slaDays: e.target.value })} />
          </Field>
          <Field label={t('linkedTo')}>
            <select value={form.entityId} onChange={(e) => setForm({ ...form, entityId: e.target.value })}>
              <option value="">{t('none')}</option>
              {entities.data?.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {locale === 'hi' ? e.nameHi : e.nameEn}
                </option>
              ))}
            </select>
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
  );
}
