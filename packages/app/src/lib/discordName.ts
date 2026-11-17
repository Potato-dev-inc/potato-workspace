// "Your name" starts from the Discord login name. When the person is signed in with Discord and the name field is
// empty, the Discord name is put in once for that account. After that the field is theirs: clearing it stays cleared.
import { useEffect } from 'react';
import { accountApi, type AccountApi, type AccountView } from './account';

export const LS_NAME_FILLED = 'pm.yourName.discordFilled';

/** The Discord name of a signed-in account, trimmed and cut to the field's length; null for anything else. */
export function discordNameOf(view: Pick<AccountView, 'signed_in' | 'account'> | null | undefined): string | null {
  const account = view?.account;
  if (!view?.signed_in || !account || account.provider.toLowerCase() !== 'discord') return null;
  const name = account.display_name.replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || null;
}

function filledFor(): string | null {
  try {
    return localStorage.getItem(LS_NAME_FILLED);
  } catch {
    return null;
  }
}

/** One check: when signed in with Discord and this account has not filled the name yet, save it. Returns the name saved, or null. */
export async function fillDiscordNameOnce(save: (name: string) => void | Promise<unknown>, api: Pick<AccountApi, 'state'> = accountApi): Promise<string | null> {
  try {
    const view = await api.state();
    const name = discordNameOf(view);
    if (!name || !view.account || filledFor() === view.account.id) return null;
    try {
      localStorage.setItem(LS_NAME_FILLED, view.account.id);
    } catch {
      /* no storage: it may fill again next time */
    }
    await save(name);
    return name;
  } catch {
    return null;
  }
}

/**
 * Fills the name once. `current` is the saved name (empty counts as no name); `save` writes it. Runs on mount and
 * whenever the sign-in changes.
 */
export function useDiscordNameFill(current: string | null | undefined, save: (name: string) => void, api: Pick<AccountApi, 'state' | 'onChanged'> = accountApi): void {
  const empty = !current || current.trim() === '';
  useEffect(() => {
    if (!empty) return;
    let alive = true;
    const check = () => {
      api
        .state()
        .then((view) => {
          const name = discordNameOf(view);
          if (!alive || !name || !view.account || filledFor() === view.account.id) return;
          try {
            localStorage.setItem(LS_NAME_FILLED, view.account.id);
          } catch {
            /* no storage: it may fill again next time */
          }
          save(name);
        })
        .catch(() => undefined);
    };
    check();
    let off: (() => void) | undefined;
    void (async () => api.onChanged(check))()
      .then((stop) => {
        if (alive) off = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
    // `save` changes every render; the fill depends on the name being empty only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, api]);
}
