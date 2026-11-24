// "Use my own agents" (P6.1): the chat runs on another PC of mine, on my sign-in here. The pane's account chip reads
// "My sign-in from <this PC>"; what it shows of the sign-in and the numbers is THIS PC's (the lend's own record on this PC).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi } from '../../lib/devices';
import { isActiveIn, isActiveOut, lendApi, problemText, usageText, type Grant, type LendApi } from '../../lib/lend';
import { Popover } from '../common/Floating';
import { useLend, type LendHandle } from './useLend';
import '../../styles/lend.css';

/** The lend (mine, active) that a pane of another PC runs on, by the pane's key on this screen. Null for any other pane. */
export function lentGrantOf(lend: LendHandle, paneKey: string): Grant | null {
  const state = lend.state;
  return state?.grants.find((g) => isActiveOut(g, lend.now) && g.peer_node && g.pane_ids.includes(paneKey)) ?? null;
}

/**
 * The lend of MY OWN PCs that a chat runs on, seen from either screen. `mine`: this PC is the lender (the pane is a far chat on a lend of my own sign-in,
 * listed by its `dev:` key). Not mine: this PC runs the agent and borrowed the sign-in (the pane is listed by its own id). `active`: the lend still runs;
 * an ended one keeps listing its panes, so a chat whose lend ran out is still known as lent (its words stay about the lent sign-in). Null for a chat on
 * its own PC's sign-in and for a teammate's lend (`peer_node` is only set when the other PC is mine).
 */
export function lentPaneOf(lend: LendHandle, paneKey: string): { grant: Grant; mine: boolean; active: boolean } | null {
  const listed = (lend.state?.grants ?? []).filter((g) => !!g.peer_node && g.pane_ids.includes(paneKey));
  const running = listed.find((g) => isActiveOut(g, lend.now) || isActiveIn(g, lend.now));
  const grant = running ?? listed[0];
  return grant ? { grant, mine: grant.direction === 'out', active: !!running } : null;
}

/**
 * The usage bar of the open far chat: the far PC's numbers, except for a chat on MY lent sign-in, whose numbers are this PC's (the sign-in is
 * here). `far` null stays null.
 */
export function usageFarOf<T>(far: T | null, lend: LendHandle, paneKey: string | undefined): T | null {
  return far && paneKey && lentPaneOf(lend, paneKey)?.mine ? null : far;
}

/** What a lent chat says when the sign-in under it ended: on the lender's screen it is this PC's sign-in, on the other it is the lender's. */
export function lentSignedOutText(lent: { grant: Grant; mine: boolean }, t: ReturnType<typeof useT>): string {
  if (lent.mine) return t('myAgents.signedOutHere');
  const name = lent.grant.peer_device_name;
  return name ? t('myAgents.signedOutThere', { name }) : t('myAgents.signedOutThereNoName');
}

/** This PC's own name (once, only while a lent pane is open). */
function useThisPcName(on: boolean, api: DevicesApi): string {
  const [name, setName] = useState('');
  useEffect(() => {
    if (!on) return;
    let live = true;
    api
      .state()
      .then((v) => live && setName(v?.name ?? ''))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [on, api]);
  return name;
}

/** Nothing for any pane that does not run on one of my lends. */
export function LentChip({ paneId, api = lendApi, devices = devicesApi, lend }: { paneId: string; api?: LendApi; devices?: DevicesApi; lend?: LendHandle }) {
  const t = useT();
  const own = useLend(api);
  const handle = lend ?? own;
  const grant = lentGrantOf(handle, paneId);
  const name = useThisPcName(!!grant, devices);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  if (!grant) return null;
  const problem = problemText(grant);
  const used = usageText(grant);
  const label = t('myAgents.chip', { name: name || t('connect.thisPc.name') });
  return (
    <span className="lend-chip-wrap" ref={wrap}>
      <button type="button" className="lend-chip" data-problem={problem ? 'true' : undefined} title={open ? undefined : (problem ?? t('myAgents.chipTip'))} data-testid="lent-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <Popover anchorRef={wrap} onClose={() => setOpen(false)} align="start" className="lend-pop" label={label}>
          <p className="lend-pop-title">{label}</p>
          <p className="lend-note">{t('myAgents.chipTip')}</p>
          {used && (
            <p className="lend-usage" data-testid="lent-usage">
              {t('myAgents.used', { used })}
            </p>
          )}
          {problem && (
            <p className="lend-error" role="status" data-testid="lent-problem">
              {problem}
            </p>
          )}
        </Popover>
      )}
    </span>
  );
}
