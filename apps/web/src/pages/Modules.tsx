/**
 * Modules screen: effective state of every module and feature at the selected
 * area, with the resolver's explanation ("why") and buttons to propose changes.
 */
import { useState } from 'react';
import { get } from '../api';
import { ErrorBox, Pill, useAsync } from '../components';
import { fmtTime, pick, useT } from '../i18n';
import type { Capabilities, ModuleState } from '../types';
import { ProposeDialog, type Proposal } from './Propose';

export function ModulesPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const { data, error, loading, reload } = useAsync(() => get<{ modules: ModuleState[] }>(`/api/v1/modules?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const canPropose = Boolean(caps['platform.change_requests']?.create);

  /** Opens the proposal dialog for a module or feature setting. */
  const propose = (kind: 'MODULE_SETTING' | 'FEATURE_SETTING', key: string, label: string, state: 'ENABLED' | 'DISABLED' | 'INHERIT') =>
    setProposal({
      title: `${t('proposeChange')}: ${label} → ${state === 'ENABLED' ? t('enabled') : state === 'DISABLED' ? t('disabled') : t('inherit')}`,
      nodeId,
      kind,
      payload: kind === 'MODULE_SETTING' ? { moduleId: key, state } : { featureCode: key, state }
    });

  /** The two states a setting can move to from its current one. */
  const options = (cur: string) => (['ENABLED', 'DISABLED', 'INHERIT'] as const).filter((s) => s !== cur);

  return (
    <section>
      <h2>{t('modulesTitle')}</h2>
      <p className="help">{t('modulesHelp')}</p>
      {loading && <p>{t('loading')}</p>}
      <ErrorBox error={error} onRetry={reload} />
      {data?.modules.map((m) => (
        <article key={m.id} className="card module" data-module={m.id}>
          <header className="row spread">
            <h3>
              {pick(m.name, locale)} <small>v{m.version}</small>
            </h3>
            <div className="row">
              {m.invariant && <Pill tone="info">{t('protected')}</Pill>}
              <span className="muted">
                {t('setting')}: {m.explicit === 'INHERIT' ? t('inherit') : m.explicit === 'ENABLED' ? t('enabled') : t('disabled')}
              </span>
              {canPropose &&
                !m.invariant &&
                options(m.explicit).map((s) => (
                  <button key={s} type="button" data-testid={`set-${s}`} className="secondary small" onClick={() => propose('MODULE_SETTING', m.id, pick(m.name, locale), s)}>
                    {s === 'ENABLED' ? t('enabled') : s === 'DISABLED' ? t('disabled') : t('inherit')}
                  </button>
                ))}
            </div>
          </header>
          {m.killSwitch && (
            <p className="warn">
              {t('killActive')} {fmtTime(m.killSwitch.expiresAt, locale)}
            </p>
          )}
          <table>
            <tbody>
              {m.features.map((f) => (
                <tr key={f.code} data-feature={f.code}>
                  <td>
                    {pick(f.name, locale)}
                    <div className="muted mono">{f.code}</div>
                  </td>
                  <td>{f.available ? <Pill tone="ok">{t('available')}</Pill> : <Pill tone="off">{t('unavailable')}</Pill>}</td>
                  <td className="muted">{f.explicit === 'INHERIT' ? t('inherit') : f.explicit === 'ENABLED' ? t('enabled') : t('disabled')}</td>
                  <td>
                    <button type="button" className="link" onClick={() => setOpenTrace(openTrace === f.code ? null : f.code)} aria-expanded={openTrace === f.code}>
                      {t('why')}
                    </button>
                    {openTrace === f.code && (
                      <ol className="trace">
                        {f.trace.map((s, i) => (
                          <li key={i}>
                            <span className={`dec dec-${s.decision}`}>{s.decision}</span> {s.detail}
                          </li>
                        ))}
                      </ol>
                    )}
                  </td>
                  <td>
                    {canPropose &&
                      !f.invariant &&
                      options(f.explicit).map((s) => (
                        <button key={s} type="button" data-testid={`set-feature-${s}`} className="secondary small" onClick={() => propose('FEATURE_SETTING', f.code, pick(f.name, locale), s)}>
                          {s === 'ENABLED' ? t('enabled') : s === 'DISABLED' ? t('disabled') : t('inherit')}
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ))}
      <ProposeDialog
        proposal={proposal}
        onClose={(submitted) => {
          setProposal(null);
          if (submitted) reload();
        }}
      />
    </section>
  );
}
