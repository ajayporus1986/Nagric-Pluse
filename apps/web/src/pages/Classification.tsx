/**
 * Jurisdiction classification: what kind of place a node actually is --
 * urban body type, rural governing body, policing model, Union Territory
 * status, and more. Every value is an admin-addable row (platform.
 * classification_axes/values), never assumed from the area's name, size, or
 * from another district's shape (see the governance-taxonomy research doc).
 * Changing a value goes through the same Realm Governor quorum as any other
 * Lego setting -- there is no direct edit here, only "Propose value".
 */
import { useState } from 'react';
import { get } from '../api';
import { ErrorBox, useAsync } from '../components';
import { useT } from '../i18n';
import type { Capabilities, ClassificationAxis } from '../types';
import { ProposeDialog, type Proposal } from './Propose';

export function ClassificationPage({ nodeId, caps }: { nodeId: string; caps: Capabilities }) {
  const { t, locale } = useT();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const classifications = useAsync(() => get<{ axes: ClassificationAxis[] }>(`/api/v1/classifications?nodeId=${encodeURIComponent(nodeId)}`, locale), [nodeId, locale]);
  const canPropose = Boolean(caps['platform.change_requests']?.create);

  const nameOf = (axis: ClassificationAxis, code: string | null) => {
    if (!code) return t('unset');
    const v = axis.values.find((x) => x.code === code);
    return v ? (locale === 'hi' ? v.nameHi : v.nameEn) : code;
  };

  return (
    <section>
      <h2>{t('classificationTitle')}</h2>
      <p className="muted">{t('classificationIntro')}</p>
      <div className="card">
        {classifications.loading && <p>{t('loading')}</p>}
        <ErrorBox error={classifications.error} onRetry={classifications.reload} />
        <table className="list">
          <thead>
            <tr>
              <th>{t('entityKind')}</th>
              <th>{t('currentValue')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {classifications.data?.axes
              .filter((a) => !a.multi) // multi-valued axes (e.g. grievanceFrictionReason) are set per-report, not per-node
              .map((a) => (
                <tr key={a.code}>
                  <td title={a.descriptionEn ?? ''}>{locale === 'hi' ? a.nameHi : a.nameEn}</td>
                  <td>{nameOf(a, a.current)}</td>
                  <td className="actions">
                    {canPropose && (
                      <>
                        <select value={picked[a.code] ?? ''} onChange={(e) => setPicked({ ...picked, [a.code]: e.target.value })}>
                          <option value="">{t('unset')}</option>
                          {a.values.map((v) => (
                            <option key={v.code} value={v.code}>
                              {locale === 'hi' ? v.nameHi : v.nameEn}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() =>
                            setProposal({
                              title: `${t('proposeClassification')} – ${locale === 'hi' ? a.nameHi : a.nameEn}`,
                              nodeId,
                              kind: 'NODE_CLASSIFICATION_SET',
                              payload: { axisCode: a.code, valueCode: picked[a.code] || null }
                            })
                          }
                        >
                          {t('proposeClassification')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <ProposeDialog proposal={proposal} onClose={() => { setProposal(null); classifications.reload(); }} />
    </section>
  );
}
