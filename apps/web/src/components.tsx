/**
 * Small shared UI pieces: error display, async loading hook, form field,
 * dialog and error boundary. Kept dependency-free on purpose.
 */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ERRORS } from '@np/shared';
import { ApiError } from './api';
import { useT } from './i18n';
import { reportClientError } from './logger';

/**
 * Shows an error with its catalogue code and request reference, so a user can
 * quote "NP-POL-0001, reference 7bf5…" to support. Never shows stack traces.
 */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, locale } = useT();
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError('NP-CLIENT-0002', ERRORS['NP-CLIENT-0002'][locale], 0);
  return (
    <div className="error" role="alert" data-code={e.code}>
      <strong>{e.message}</strong>
      {e.fields && e.fields.length > 0 && (
        <ul>
          {e.fields.map((f, i) => (
            <li key={i}>
              {f.path ? `${f.path}: ` : ''}
              {f.message}
            </li>
          ))}
        </ul>
      )}
      <div className="error-ref">
        {e.code}
        {e.requestId ? ` · ${t('errorRef')} ${e.requestId}` : ''}
      </div>
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  );
}

/** Loads data with `fn` whenever `deps` change. Ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => mine === seq.current && setState({ data, error: undefined, loading: false }),
      (error: unknown) => mine === seq.current && setState({ data: undefined, error, loading: false })
    );
    // `deps` is supplied by the caller (same contract as useEffect's dependency list).
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

/**
 * Wraps a submit handler: tracks busy state and the last error, and prevents
 * double submission (each click waits for the previous one to finish).
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): { run: (...args: A) => Promise<R | undefined>; busy: boolean; error: unknown; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const inFlight = useRef(false);
  const run = async (...args: A) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { run, busy, error, clear: () => setError(undefined) };
}

/** Labelled input. */
export function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

/** Modal dialog using the native <dialog> element (focus trap and Esc built in). */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title}>
      <h2>{title}</h2>
      {open && children}
    </dialog>
  );
}

/** Catches render errors in a subtree, reports them, and shows a recoverable message. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    reportClientError('error', 'NP-CLIENT-0002', error.message, undefined, error.stack);
  }
  override render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/** Status pill. */
export function Pill({ tone, children }: { tone: 'ok' | 'off' | 'warn' | 'info'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
