// English messages for minions and spin-offs (minions plan section 3 and 4.2). Keys are dotted. Plural: `<key>_one` / `<key>_other`.
// The Two types wording of the same keys is in ./twoTypes.ts and is merged over these only in Two types mode.
export const minions = {
  'minion.row.working': 'Minion working',
  'minion.row.minion': 'Minion',
  'minion.row.named': 'Minion: {description}',
  'minion.row.see': 'See {title}',
  'minion.row.status': '{kind} {status}',
  'minion.row.titled': '{kind}: {title}',
  'minion.row.startedAgent': 'Started agent',
  'minion.activity.started_one': 'Started {count} agent',
  'minion.activity.started_other': 'Started {count} agents',
  'minion.budget.label': 'Started agents',
  'side.noAgent': 'No agent is set up for side questions yet. Set one up in Agents.',
  'side.reads': 'Another agent reads the recent chat and answers here. Your agent does not see this.',
  'crew.leftOut_one': '{count} more agent was left out. A crew holds at most 8 agents.',
  'crew.leftOut_other': '{count} more agents were left out. A crew holds at most 8 agents.',
  'live.andIts_one': 'and its {count} started agent',
  'live.andIts_other': 'and its {count} started agents',
  'companion.newDesc': 'An always-on assistant that runs on your agent',
  'companion.setup.lead': 'Your own assistant that is always on. It runs on your agent and your plan.',
} as const;
