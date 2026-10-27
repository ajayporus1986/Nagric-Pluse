/**
 * Dialog for submitting a change request of any kind. Shows the server's
 * impact preview after submission so the proposer sees exactly what the
 * change will do before others approve it.
 */
import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { Dialog, ErrorBox, Field, useAction } from '../components';
import { useT } from '../i18n';
import type { ChangeRequest } from '../types';
import { ImpactView } from './Changes';

export interface Proposal {
  title: string;
  nodeId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export function ProposeDialog({ proposal, onClose }: { proposal: Proposal | null; onClose: (submitted: boolean) => void }) {
  const { t, locale } = useT();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ impact: ChangeRequest['impact']; requiredApprovals: number } | null>(null);
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    if (!proposal) return;
    const r = await post<{ id: string; impact: ChangeRequest['impact']; requiredApprovals: number }>(
      '/api/v1/change-requests',
      { nodeId: proposal.nodeId, kind: proposal.kind, payload: proposal.payload, reason },
      locale
    );
    setResult(r);
  });
  /** Resets local state and tells the parent whether anything was submitted. */
  const close = () => {
    const submitted = result !== null;
    setReason('');
    setResult(null);
    action.clear();
    onClose(submitted);
  };
  return (
    <Dialog open={proposal !== null} title={proposal?.title ?? ''} onClose={close}>
      {result ? (
        <div>
          <p className="ok" role="status">{t('proposed')}</p>
          <h3>{t('impact')}</h3>
          <ImpactView impact={result.impact} />
          <button type="button" onClick={close}>
            {t('close')}
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void action.run(e)}>
          <pre className="payload">{JSON.stringify({ kind: proposal?.kind, ...proposal?.payload }, null, 2)}</pre>
          <Field label={t('reason')}>
            <textarea name="reason" required minLength={10} maxLength={2000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBox error={action.error} />
          <div className="row">
            <button type="submit" disabled={action.busy}>
              {t('submit')}
            </button>
            <button type="button" className="secondary" onClick={close}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
