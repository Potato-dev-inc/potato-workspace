// Artifacts: a page an agent made (HTML, Markdown, SVG or a Mermaid diagram). The chat carries it as a card (a notice of
// kind `artifact`); this file knows the card's address, the calls to the PC, and the page each kind is shown as.
import { invoke } from '@tauri-apps/api/core';

export type ArtifactKind = 'html' | 'markdown' | 'svg' | 'mermaid';

export interface ArtifactVersion {
  n: number;
  at: string;
  bytes: number;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  createdAt: string;
  updatedAt: string;
  versions: ArtifactVersion[];
}

export interface ArtifactPage {
  artifact: Artifact;
  version: number;
  content: string;
  /** Where the version's file is on this PC (desktop only; a phone is never told). */
  path: string;
}

/** What a card points at. */
export interface ArtifactRef {
  id: string;
  version: number;
  kind: ArtifactKind;
}

const KINDS: readonly ArtifactKind[] = ['html', 'markdown', 'svg', 'mermaid'];
export const isArtifactKind = (word: string): word is ArtifactKind => (KINDS as readonly string[]).includes(word);

/** The notice's `notice_kind` that makes a chat line a card. */
export const ARTIFACT_NOTICE = 'artifact';

/** `potato-artifact:<id>/<version>/<kind>` (the notice's address), or null for any other text. Same rule as the PC's. */
export function parseArtifactRef(url: string | null | undefined): ArtifactRef | null {
  const m = /^potato-artifact:([a-z0-9][a-z0-9-]{0,47})\/([1-9]\d{0,8})\/([a-z]+)$/.exec(url ?? '');
  if (!m || !isArtifactKind(m[3])) return null;
  return { id: m[1], version: Number(m[2]), kind: m[3] };
}

export const KIND_WORD: Record<ArtifactKind, string> = { html: 'HTML', markdown: 'Markdown', svg: 'SVG', mermaid: 'Diagram' };

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The mermaid script is pinned to one exact version, from one allowed CDN. */
export const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';

/** The page a kind is shown as inside the locked frame, and whether it needs scripts / the CDN list. */
export interface FramePage {
  html: string;
  allowScripts: boolean;
  cdn: boolean;
}

const BASE_STYLE = 'html,body{margin:0;padding:0}body{font:14px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff}';

/** The page for an HTML, SVG or Mermaid artifact. (Markdown is drawn by the app's own renderer, not in a frame.) */
export function framePage(kind: ArtifactKind, content: string): FramePage {
  if (kind === 'html') return { html: content, allowScripts: true, cdn: true };
  if (kind === 'svg') {
    // An SVG is a picture: no scripts, whatever it contains.
    return { html: `<!DOCTYPE html><meta charset="utf-8"><style>${BASE_STYLE}svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>${content}`, allowScripts: false, cdn: false };
  }
  const source = escapeHtml(content);
  return {
    html:
      `<!DOCTYPE html><meta charset="utf-8"><style>${BASE_STYLE}body{padding:16px}pre.mermaid{text-align:center;white-space:pre-wrap}</style>` +
      `<pre class="mermaid">${source}</pre>` +
      `<script type="module">import mermaid from '${MERMAID_SRC}';mermaid.initialize({startOnLoad:false,securityLevel:'strict'});try{await mermaid.run({querySelector:'.mermaid'})}catch(e){}</script>`,
    allowScripts: true,
    cdn: true,
  };
}

/** The calls the artifact tab and the card need (a test double can stand in). */
export interface ArtifactsApi {
  /** Looks for pages the agent dropped into the folder (each new one gets a card), then lists the project's pages. */
  sync(paneId: string): Promise<Artifact[]>;
  read(paneId: string, id: string, version?: number): Promise<ArtifactPage>;
  openInBrowser(paneId: string, id: string, version?: number): Promise<void>;
  /** Makes a read-only link to one version (`ttlHours`: 1 to 168, a day when left out). The secret is inside the link, shown once. */
  shareMake(paneId: string, id: string, version: number, ttlHours: number): Promise<ArtifactShareMade>;
  /** The links of this page that have not ended (never their secrets). */
  shareList(paneId: string, id: string): Promise<ArtifactShareView[]>;
  /** Stops every link of this page. */
  shareStop(paneId: string, id: string): Promise<number>;
  /** Opens the page in a window of its own. */
  popOut(paneId: string, id: string, title: string): Promise<void>;
  /** Opens the page as a tab of the agent browser (the agent can then read and click it). The PC serves it to that tab only. */
  openInAgentBrowser(paneId: string, id: string): Promise<void>;
}

/** A link just made. `link` is null when this PC has no public address (`reason` says so). */
export interface ArtifactShareMade {
  link: string | null;
  version: number;
  /** Milliseconds since 1970. */
  expiresAt: number;
  reason?: string | null;
}

export interface ArtifactShareView {
  version: number;
  createdAt: number;
  expiresAt: number;
}

/** The times the share box offers (hours). The PC keeps them between one hour and seven days. */
export const SHARE_HOURS = [1, 24, 168] as const;

export const artifactsApi: ArtifactsApi = {
  sync: (paneId) => invoke<Artifact[]>('artifacts_sync', { paneId }),
  read: (paneId, id, version) => invoke<ArtifactPage>('artifacts_read', { paneId, id, version }),
  openInBrowser: (paneId, id, version) => invoke<void>('artifacts_open_in_browser', { paneId, id, version }),
  shareMake: (paneId, id, version, ttlHours) => invoke<ArtifactShareMade>('artifacts_share_make', { paneId, id, version, ttlHours }),
  shareList: (paneId, id) => invoke<ArtifactShareView[]>('artifacts_share_list', { paneId, id }),
  shareStop: (paneId, id) => invoke<number>('artifacts_share_stop', { paneId, id }),
  popOut: (paneId, id, title) => invoke<void>('artifacts_pop_out', { paneId, id, title }),
  openInAgentBrowser: (paneId, id) => invoke<void>('artifacts_open_in_agent_browser', { paneId, id }),
};

/** Whether the system's browser can show this kind by itself. */
export const opensInBrowser = (kind: ArtifactKind) => kind === 'html' || kind === 'svg';
