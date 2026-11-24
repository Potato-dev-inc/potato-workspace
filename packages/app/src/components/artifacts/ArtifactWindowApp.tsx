// Root of an artifact's own window (route `index.html?artifactwin=1&pane=..&id=..`, label `artifact-window-<id>`): one page
// with its own tools (Point, Share, versions). Point sends to the chat that made the page, the same as beside the chat.
import { usePopoutChrome } from '../../hooks/usePopoutChrome';
import { ArtifactTab } from './ArtifactTab';

export default function ArtifactWindowApp() {
  const theme = usePopoutChrome();
  const params = new URLSearchParams(window.location.search);
  const paneId = params.get('pane') ?? '';
  const id = params.get('id') ?? '';
  return (
    <div className="cockpit ck-artwin" data-theme={theme}>
      {paneId && id ? <ArtifactTab paneId={paneId} id={id} /> : null}
    </div>
  );
}
