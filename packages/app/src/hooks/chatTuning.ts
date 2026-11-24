/** How long a chat nobody looks at keeps its reader, and how long a chat opened right after another waits (tests set both to 0). */
export const chatTuning = { graceMs: 2000, settleMs: 250 };

/** The open chats by key (tests empty it between tests, so one test's chat never leaks into the next). */
export const chatStores = new Map<string, { key: string }>();

/** The last transcript of each chat, kept so a reopened chat shows it at once (tests empty it too). */
export const chatKept = new Map<string, unknown>();
