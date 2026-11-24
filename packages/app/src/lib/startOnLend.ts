// "Switch to the borrowed sign-in" on a far chat: a new chat in the same project on that PC (it takes the lend this PC made, while its own
// login is out). The far PC knows a project by the opaque id its session list gave (`row.project`, a copy's chat names its real project),
// never by the folder name a far pane shows as its cwd; so the id is what is sent, as the New agent page does. A chat that worked on a copy
// asks for a copy again. A refusal is told as "<PC> said no: <reason>"; the raw error goes to the console.
import { t } from '../i18n';
import type { AcpStarted } from './acpChat';
import { errorSentence } from './sayError';

export interface StartOnLend {
  start: (agentId: string, folder: string, explicit?: boolean, accountId?: string, separateCopy?: boolean) => Promise<AcpStarted>;
  agent: string;
  /** The old far chat's pane info (it carries the far project id and whether it worked on a copy). */
  info: object | undefined;
  /** The far PC's name, for the refusal sentence. */
  pcName?: string;
}

/** The far project id and copy flag a far pane's info carries (`paneOf`). */
export const farProjectOf = (info: object | undefined): { project?: string; copy: boolean } => {
  const i = (info ?? {}) as { far_project?: unknown; far_copy?: unknown };
  return { project: typeof i.far_project === 'string' && i.far_project ? i.far_project : undefined, copy: i.far_copy === true };
};

/** Starts the new far chat. Resolves with its pane id; throws one plain sentence. */
export async function startOnLend({ start, agent, info, pcName }: StartOnLend): Promise<string> {
  const { project, copy } = farProjectOf(info);
  if (!project) throw new Error(t('chat.signin.useLendNoFolder'));
  try {
    return (await start(agent, project, true, undefined, copy || undefined)).pane_id;
  } catch (e) {
    console.error('use-lend start failed', { agent, project, error: e });
    throw new Error(t('chat.signin.useLendFailed', { name: pcName || t('chat.signin.thatPc'), why: errorSentence(e) }));
  }
}
