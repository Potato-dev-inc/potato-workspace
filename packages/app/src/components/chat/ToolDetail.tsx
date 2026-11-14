// The open part of a tool card: the files it touched as chips, then an edit's diff, a command, or the input as JSON,
// then the output. Agent text and tool output are data: shown as plain text only.
import { useRef, useState } from 'react';
import type { ToolCallItem, ToolResultItem, ToolStep } from '../../lib/sessionChatModel';
import '../../styles/chat-agent-cards.css';
import { kindOfCall } from './chatActivity';
import { diffHunks, diffStats, editPairs, lineDiff, patchLines, patchOf, patchText, type DiffLine, type DiffOp } from './chatDiff';
import { baseName } from './chatFormat';
import { useCopy } from './useCopy';
import { useChatPane } from './ChatPane';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { EditorMenuItems } from '../files/OpenInEditor';

/** The diff of an edit or write call, or null when its input holds no old or new text. */
export function diffLinesOf(call: ToolCallItem): DiffLine[] | null {
  const kind = kindOfCall(call);
  if (kind !== 'edit' && kind !== 'write') return null;
  const patch = patchOf(call.input);
  if (patch !== null) return patchLines(patch);
  const pairs = editPairs(call.input);
  return pairs ? pairs.flatMap((pair) => lineDiff(pair.before, pair.after)) : null;
}

/** The command of a run call: its `command` text, or the words of a command list. */
export function commandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return null;
}

export function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const GUTTER: Record<DiffOp, string> = { same: ' ', add: '+', del: '-', head: '' };

export function DetailLabel({ children }: { children: string }) {
  return <p className="ck-chat-detail-label ck-agc-label">{children}</p>;
}

/** Paths as chips: the file name shows, the full path is the tooltip. */
export function PathChips({ paths }: { paths: readonly string[] }) {
  const paneId = useChatPane();
  const [menu, setMenu] = useState<{ path: string; anchor: HTMLElement } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <ul className="flex flex-wrap gap-1 ck-chat-chips" aria-label="Files">
        {paths.map((path) => (
          <li key={path} className="min-w-0">
            {paneId ? (
              // A click, Enter or a right-click offers "Open in editor" for the file.
              <button
                type="button"
                className="inline-block max-w-full truncate font-mono text-[11px] ck-chat-chip"
                title={path}
                aria-haspopup="menu"
                onClick={(e) => setMenu({ path, anchor: e.currentTarget })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ path, anchor: e.currentTarget });
                }}
              >
                {baseName(path)}
              </button>
            ) : (
              <span className="inline-block max-w-full truncate font-mono text-[11px] ck-chat-chip" title={path}>
                {baseName(path)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {paneId && menu && (
        <FloatingMenu anchorRef={{ current: menu.anchor }} align="start" label={baseName(menu.path)} onClose={() => setMenu(null)}>
          <EditorMenuItems paneId={paneId} path={menu.path} onDone={() => setMenu(null)} onFail={setProblem} />
        </FloatingMenu>
      )}
      {problem && (
        <p className="ck-sub" role="status">
          {problem}
        </p>
      )}
    </>
  );
}

/** A copy button: "Copy", then "Copied" (the clipboard took it) or "Selected" (the text is selected to copy by hand). */
function CopyButton({ text, target, label = 'Copy' }: { text: string; target?: () => Element | null; label?: string }) {
  const { state, copy } = useCopy();
  return (
    <button type="button" className="ck-agc-copy" data-copied={state !== 'idle' || undefined} onClick={() => void copy(text, target?.() ?? null)}>
      {state === 'copied' ? 'Copied' : state === 'selected' ? 'Selected' : label}
    </button>
  );
}

/**
 * An edit as a file card: the file with "+12 -3", then the changes by hunk with a `+` or `-` gutter, and Copy patch.
 * The agent already made the change, so there is nothing to accept or reject here.
 */
export function DiffBlock({ lines, path }: { lines: readonly DiffLine[]; path?: string | null }) {
  const { added, removed } = diffStats(lines);
  const hunks = diffHunks(lines);
  return (
    <div className="ck-agc-diff" data-testid="tool-diff">
      <div className="ck-agc-diff-head">
        <span className="ck-agc-diff-path" title={path ?? undefined}>
          {path ? baseName(path) : 'Changes'}
        </span>
        <span className="ck-agc-diff-stat">+{added}</span>
        <span className="ck-agc-diff-stat">{'−'}{removed}</span>
        <span className="ck-agc-grow" />
        <CopyButton text={patchText(lines, path)} label="Copy patch" />
      </div>
      <div className="ck-agc-diff-scroll">
        {hunks.map((hunk, h) => (
          <div key={h} className="ck-agc-hunk">
            {hunk.head !== null && <div className="ck-agc-hunk-head ck-chat-diff-line--head">{hunk.head}</div>}
            {hunk.lines.map((line, index) => (
              <div key={index} className={`ck-agc-line ck-chat-diff-line--${line.op}`}>
                <span aria-hidden="true" className="ck-agc-gutter ck-chat-diff-gutter">
                  {GUTTER[line.op]}
                </span>
                <span className="ck-agc-line-text">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A mono block with a scroll cap: the command, or the input as JSON. */
export function CodeBlock({ label, text }: { label: string; text: string }) {
  return (
    <>
      <DetailLabel>{label}</DetailLabel>
      <pre className="ck-agc-code max-h-48 overflow-auto whitespace-pre-wrap break-all">{text}</pre>
    </>
  );
}

/** The tool's output (or that it has none yet) in a terminal look, scrollable with a cap, with a Copy button. */
export function OutputBlock({ result, failed = false }: { result: ToolResultItem | null; failed?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <>
      <DetailLabel>Output</DetailLabel>
      <div className="ck-agc-term" data-failed={failed || undefined}>
        <div className="ck-agc-term-head">
          <span>{failed ? 'Terminal · failed' : 'Terminal'}</span>
          <span className="ck-agc-grow" />
          {result && result.output !== '' && <CopyButton text={result.output} target={() => ref.current} />}
        </div>
        <pre ref={ref} data-testid="tool-output" tabIndex={0} className="ck-agc-term-body max-h-48 overflow-auto whitespace-pre-wrap break-all">
          {result ? result.output : 'No output yet.'}
        </pre>
      </div>
    </>
  );
}

export function ToolDetail({ step, failed = false }: { step: ToolStep; failed?: boolean }) {
  const { call, result } = step;
  const paths = [...new Set((call.paths ?? []).filter((path) => typeof path === 'string' && path !== ''))];
  const diff = diffLinesOf(call);
  const command = kindOfCall(call) === 'run' ? commandOf(call.input) : null;
  return (
    <div className="space-y-1 ck-chat-detail ck-agc-detail">
      {paths.length > 0 && <PathChips paths={paths} />}
      {diff ? (
        <>
          <DetailLabel>Changes</DetailLabel>
          <DiffBlock lines={diff} path={paths[0] ?? null} />
        </>
      ) : command !== null ? (
        <CodeBlock label="Command" text={command} />
      ) : call.input != null ? (
        <CodeBlock label="Input" text={jsonOf(call.input)} />
      ) : null}
      <OutputBlock result={result} failed={failed} />
    </div>
  );
}
