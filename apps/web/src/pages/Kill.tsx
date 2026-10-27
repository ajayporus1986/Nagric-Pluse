/**
 * Emergency stop screen: list stops in this area, stop a module for up to
 * 24 hours (platform operators), lift a stop, or propose to keep it off.
 */
import { useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { ErrorBox, Field, Pill, useAction, useAsync } from '../components';
import { fmtTime, pick, useT } from '../i18n';
import type { Capabilities, KillSwitch, ModuleState } from '../types';
import { ProposeDialog, type Proposal } from './Propose';

export function KillPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const list = useAsync(() => get<{ killSwitches: KillSwitch[] }>(`/api/v1/kill-switches?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const canStop = Boolean(caps['platform.kill_switch']?.special);
  const canPropose = Boolean(caps['platform.change_requests']?.create);
  // Module list is only needed (and only permitted) for operators who can stop modules.
  const modules = useAsync(
    () => (canStop && caps['platform.modules']?.view ? get<{ modules: ModuleState[] }>(`/api/v1/modules?nodeId=${encodeURIComponent(nodeId)}`, locale) : Promise.resolve({ modules: [] as ModuleState[] })),
    [nodeId, locale, canStop]
  );
  const [form, setForm] = useState({ moduleId: '', hours: 4, reason: '' });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const stop = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await post('/api/v1/kill-switches', { nodeId, moduleId: form.moduleId, hours: form.hours, reason: form.reason }, locale);
    setForm({ moduleId: '', hours: 4, reason: '' });
    list.reload();
  });
  const clear = useAction(async (id: string) => {
    await post(`/api/v1/kill-switches/${id}/clear`, {}, locale);
    list.reload();
  });
  // Protected modules are never offered.
  const stoppable = modules.data?.modules.filter((m) => !m.invariant) ?? [];

  return (
    <section>
      <h2>{t('killTitle')}</h2>
      <p className="help">{t('killHelp')}</p>
      {canStop && (
        <form className="card" onSubmit={(e) => void stop.run(e)}>
          <div className="row">
            <Field label={t('module')}>
              <select name="moduleId" required value={form.moduleId} onChange={(e) => setForm({ ...form, moduleId: e.target.value })}>
                <option value="" />
                {stoppable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {pick(m.name, locale)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('hours')}>
              <input name="hours" type="number" min={1} max={24} required value={form.hours} onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label={t('reason')}>
            <textarea name="reason" required minLength={10} maxLength={2000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <ErrorBox error={stop.error} />
          <button type="submit" className="danger" disabled={stop.busy}>
            {t('activate')}
          </button>
        </form>
      )}
      <ErrorBox error={list.error ?? clear.error} onRetry={list.reload} />
      <table className="list">
        <thead>
          <tr>
            <th>{t('module')}</th>
            <th>{t('area')}</th>
            <th>{t('reason')}</th>
            <th>{t('expires')}</th>
            <th>{t('status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.killSwitches.map((k) => (
            <tr key={k.id} data-kill={k.moduleId}>
              <td className="mono">{k.moduleId}</td>
              <td>{k.nodeId}</td>
              <td>{k.reason}</td>
              <td>{fmtTime(k.expiresAt, locale)}</td>
              <td>{k.active ? <Pill tone="warn">{t('active')}</Pill> : <Pill tone="info">{t('ended')}</Pill>}</td>
              <td className="actions">
                {k.active && canStop && (
                  <button type="button" data-testid="clear-kill" className="secondary small" disabled={clear.busy} onClick={() => void clear.run(k.id)}>
                    {t('clear')}
                  </button>
                )}
                {k.active && canPropose && (
                  <button type="button" className="secondary small" onClick={() => setProposal({ title: `${t('ratify')}: ${k.moduleId}`, nodeId: k.nodeId, kind: 'KILL_SWITCH_RATIFY', payload: { killSwitchId: k.id } })}>
                    {t('ratify')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ProposeDialog
        proposal={proposal}
        onClose={(s) => {
          setProposal(null);
          if (s) list.reload();
        }}
      />
    </section>
  );
}
