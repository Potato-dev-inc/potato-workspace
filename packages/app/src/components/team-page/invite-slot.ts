// The Invite button on the Team page. It makes the one-time invite link (a link on the team's Worker that works once,
// for 24 hours) and shows it. With no Worker linked, or when the link cannot be made, it sends the person to Setup,
// where the older invite code and words live.
import type { InviteView, TeamApi } from '../../lib/team';

/** What the page gives the slot. */
export interface InviteSlotContext {
  api: Pick<TeamApi, 'invite'>;
  /** Show the made link (the page draws the sheet). */
  show: (invite: InviteView & { joinUrl: string }) => void;
  /** The fallback: the Setup tab. */
  openSetup: () => void;
}

/** True when the invite carries a one-time Worker link. */
export const hasWorkerLink = (invite: InviteView | null | undefined): invite is InviteView & { joinUrl: string } =>
  !!invite && typeof invite.joinUrl === 'string' && invite.joinUrl.length > 0;

/** Starts an invite: a one-time link when there is a Worker, else Setup. */
export async function inviteSlot(ctx: InviteSlotContext): Promise<void> {
  try {
    const invite = await ctx.api.invite();
    if (hasWorkerLink(invite)) ctx.show(invite);
    else ctx.openSetup();
  } catch {
    ctx.openSetup();
  }
}
