// Settings > Connect: its four cards (Phone, Team, Lend, Discord) start closed and open in place. Each shows one
// plain line saying what is inside. The rows behind them keep their own ids and files (arrange.tsx places them).
export const CONNECT_CARDS = ['Phone', 'Team', 'Lend', 'Discord'] as const;

// The line under each card is the i18n key `settings.connectLine.<card>`.

export const isConnectCard = (group: string | undefined): boolean => Boolean(group) && (CONNECT_CARDS as readonly string[]).includes(group as string);
