// The file viewers are separate script chunks that load when a file of their kind opens. If one cannot load (a
// stale window after an update, a file the app could not serve), only that tab shows a plain note with a way out;
// the rest of the pane keeps working.
import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { useT } from '../../i18n';

const RETRY_DELAY_MS = 300;

/** `lazy()` that tries the import a second time before it gives up. */
export function lazyViewer<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return { default: await load() };
    }
  });
}

function ViewerFailed({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <div className="ck-file-note" role="alert" data-testid="viewer-failed">
      <p>{t('files.viewerFailed')}</p>
      <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onOpen}>
        {t('files.openDefault')}
      </button>
    </div>
  );
}

/** Catches a viewer that failed to load. It resets when `resetKey` (the open file) changes. */
export class ViewerBoundary extends Component<
  { children: ReactNode; onOpen: () => void; resetKey: string },
  { failedFor: string | null }
> {
  state = { failedFor: null as string | null };

  static getDerivedStateFromError() {
    return { failedFor: '' };
  }

  componentDidCatch() {
    this.setState({ failedFor: this.props.resetKey });
  }

  componentDidUpdate() {
    if (this.state.failedFor !== null && this.state.failedFor !== '' && this.state.failedFor !== this.props.resetKey) {
      this.setState({ failedFor: null });
    }
  }

  render() {
    if (this.state.failedFor !== null) return <ViewerFailed onOpen={this.props.onOpen} />;
    return this.props.children;
  }
}
