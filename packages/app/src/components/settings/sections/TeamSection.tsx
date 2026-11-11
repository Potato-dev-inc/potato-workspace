// Settings > Team: its own page. Start a team or join one, then see the connection, the invite and the people.
// The page is one row (the whole flow is one screen); the row's words are what search finds.
import type { RowDef } from '../model';
import { TeamPage } from '../blocks/TeamPage';

export const teamRows: RowDef[] = [
  {
    id: 'team-page',
    group: 'Your team',
    label: 'Team',
    hint: 'Tell teammates when your agent pushes, and see when theirs does. Start or join a team.',
    keywords:
      'teammates heads-up co-work share push pull merge relay cloudflare invite join start create connect shared folder members owner leave link code qr people waiting',
    render: (env) => <TeamPage displayName={env.settings.display_name ?? ''} onSaved={env.markSaved} />,
  },
];
