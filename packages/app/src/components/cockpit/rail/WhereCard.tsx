// Where this pane runs: the model, the folder, the git branch and the account.
import { SIGN_IN } from '../../../lib/glossary';
import type { ReactNode } from 'react';
import { RailCard } from './RailCard';
import { shortFolder } from './railFormat';

export interface WhereCardProps {
  /** Not shown any more: the agent is the pane's title. Kept so callers need no change. */
  agentName?: string;
  model: string | null;
  cliVersion?: string | null;
  folder: string;
  /** The git branch of the folder; null when it is not a git folder (or not known yet). */
  branch: string | null;
  accountLabel?: string | null;
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="ck-rail-row">
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

export function WhereCard({ model, folder, branch, accountLabel }: WhereCardProps) {
  return (
    <RailCard title="Where" testId="rail-where" bare>
      <dl className="ck-rail-facts">
        {model && (
          <Row label="Model" title={model}>
            <span className="ck-mono">{model}</span>
          </Row>
        )}
        <Row label="Folder" title={folder}>
          {shortFolder(folder)}
        </Row>
        {branch && (
          <Row label="Branch" title={branch}>
            <span className="ck-mono">{branch}</span>
          </Row>
        )}
        {accountLabel && <Row label={SIGN_IN.rowLabel}>{accountLabel}</Row>}
      </dl>
    </RailCard>
  );
}
