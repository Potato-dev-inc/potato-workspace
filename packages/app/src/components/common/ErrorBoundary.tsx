import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportUiError } from '../../lib/globalErrors';
import './error-boundary.css';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Where this boundary sits ("Pane", "Settings page"). Used in the card marker and the copied details. */
  where?: string;
  /** Called once per caught error. Without it the error goes to the app log. Must not throw. */
  onError?: (error: unknown, where: string, componentStack: string) => void;
  /** When any of these change, the card clears and the children try again (e.g. the pane id). */
  resetKeys?: readonly unknown[];
  /** Smaller card for a row, a sheet or a pane inside a busy screen. */
  compact?: boolean;
}

interface State {
  error: { value: unknown } | null;
  stack: string;
  copied: boolean;
}

/** The text a person can paste into a bug report. Never shown on screen by default. */
export function errorDetails(error: unknown, where: string, componentStack: string): string {
  const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const isObj = typeof error === 'object' && error !== null;
  const lines = [`Where: ${where}`];
  if (isObj) {
    if (typeof e?.name === 'string') lines.push(`Name: ${e.name}`);
    lines.push(`Message: ${typeof e?.message === 'string' ? e.message : String(error)}`);
    if (typeof e?.stack === 'string') lines.push('', e.stack);
  } else {
    lines.push(`Message: ${String(error)}`);
  }
  if (componentStack) lines.push('', 'Component stack:', componentStack.trim());
  return lines.join('\n');
}

const sameKeys = (a: readonly unknown[] = [], b: readonly unknown[] = []): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Catches a render error under it and shows a calm card instead of a blank window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, stack: '', copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: { value: error }, copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = info.componentStack ?? '';
    this.setState({ stack });
    try {
      const where = this.props.where ?? 'screen';
      if (this.props.onError) this.props.onError(error, where, stack);
      else reportUiError(`ErrorBoundary: ${where}`, error, stack);
    } catch {
      /* logging must never break the fallback */
    }
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.reset();
  }

  private reset = (): void => {
    this.setState({ error: null, stack: '', copied: false });
  };

  private copy = (): void => {
    const { error, stack } = this.state;
    if (!error) return;
    const text = errorDetails(error.value, this.props.where ?? 'screen', stack);
    const done = (): void => this.setState({ copied: true });
    try {
      void navigator.clipboard.writeText(text).then(done, () => undefined);
    } catch {
      /* no clipboard here */
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className={`pm-eb${this.props.compact ? ' is-compact' : ''}`} role="alert" data-error-boundary={this.props.where ?? 'screen'}>
        <p className="pm-eb-title">Something went wrong here</p>
        <p className="pm-eb-body">The rest of the app is fine. Try again, and if it keeps happening, copy the details and send them to us.</p>
        <div className="pm-eb-actions">
          <button type="button" className="pm-eb-btn is-primary" onClick={this.reset}>
            Try again
          </button>
          <button type="button" className="pm-eb-btn" onClick={this.copy}>
            {this.state.copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </div>
    );
  }
}
