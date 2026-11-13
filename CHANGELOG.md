# Changelog

## 1.0.26

This is a beta.

- Chat first: every new agent starts as a chat. Terminals are hidden unless you turn on "Show terminals" (Settings > Agents > Advanced). Terminals you already have open keep working.
- New: a plan progress bar at the top of the chat ("3 of 6 · the current step"). Click it to see the whole checklist. Also on the phone.
- New: edit or remove a message that is waiting in the queue. Nothing in the queue is sent while you edit. Also on the phone.
- Check my setup: Test now works and remembers the result and its time. Every agent has an action (Test, Open, Install or Sign in), and agents you have not installed no longer count as problems.
- Updates: the download shows MB, speed and time left, then "Installing". A download that stops for 45 seconds ends with Try again instead of waiting forever.
- Fixed: a pane opened in its own window could crash with "Something went wrong" right after it opened.

## 1.0.25

This is a beta.

- Phone: start a new chat from the phone. Pick the agent and a project the PC already knows, choose Chat or Terminal, and type the first message.
- Phone: the model label is now a real picker for model, mode and effort, with a short line about each. Full access shows a yellow shield and needs a press and hold.
- Phone: reopen closed chats from the drawer, and press and hold a message to copy, select, share, edit and send again, or retry.
- Phone: attach a photo or file with "+" (Camera, Photos, Files, Paste; up to 10 MB). Files are kept in one folder on the PC and removed after 7 days.
- Phone: talk instead of typing where the phone supports it. Nothing is sent until you press Send.
- Phone: quick replies when the agent asks something, saved prompts with "/", a result card when a turn ends (summary, files changed, the diff), and a live progress line while an agent works.
- Every new phone action is checked on the PC against what that phone may do and the agent's own remote setting.

## 1.0.24

This is a beta.

- New phone app: it works like a chat app for your agents. It opens in the chat that needs you, a drawer from the top-left lists your agents by project, tool steps fold into one line, and one big box at the bottom does the writing.
- Phone: approvals and questions are cards in the chat (high risk needs a press and hold), a "needs you" pill shows another agent's question, Stop one agent with one tap, plain words when the PC can't be reached, setup steps after pairing, and a lock on agents the PC keeps to itself, with "Ask the PC for control". The phone is now in Traditional Chinese too.
- New: Files in the right panel. See the project's files, open one in a tab with colour, switch to what the agent changed, and tell the agent about the lines you select.
- New: the agent board (Ctrl+0): every agent in Needs you, Working and Done.
- New: drag tabs to reorder them or split, drag chats and projects in the sidebar to reorder them or pin them, drop a folder to add a project, and drop a file on a terminal to type its path.
- New: Comfort settings: text size, strong contrast, less motion, and reading results out loud.
- New: the companion can speak up when something waits for you (off until you say yes), and you can drop the Potato on an agent to ask what it is doing.
- New (Labs): a desktop Potato that sleeps on your screen and waves when an agent needs you.
- Remote control: "Allow for 15 minutes" now ends on time even if the app was closed.

## 1.0.23

This is a beta.

- New: the Potato is the app's face. The app icon, tray, taskbar and phone icon use the Potato drawing, and the companion row shows the Potato with a mood (watching, needs you, sleepy, celebrating).
- New: drag the sidebar edge and the right panel edge to make them wider or narrower. Double-click resets. Double-click a tab for focus mode; Esc brings everything back.
- New: drag a chat from the sidebar onto the left or right half to open it side by side.
- New: Remote control for each agent, in the right panel. Turn it off and paired devices cannot read, answer or type to that agent. The PC enforces it, not only the screen.
- New: continue where you left off. The start page offers to reopen the chats that were open last time, in the same split.
- New: a bell for each agent (everything, only when it needs me, only when it is finished, silent), quiet hours, and snooze for 30 minutes. Risky approvals always reach you.
- New: a usage forecast. "At this pace you hit the limit at about 15:40."
- All Settings pages are now in Traditional Chinese too.
- Early versions: the app now says when it could not check for updates, instead of saying "Up to date".
- Fixes: a pane no longer breaks when the PC answers a chat request with nothing, and a drag no longer also selects the chat.

## 1.0.22

This is a beta.

- New: Traditional Chinese (Taiwan). Settings > Look and feel > Language: Automatic, English or 繁體中文. The sidebar, Inbox, panes, status bar, New agent page, Add an agent, first run and the main Settings pages are translated; other screens stay in English for now.
- New: any agent you add can also work as a helper for your other agents, and Add an agent can learn how to talk to programs that have no chat mode. It asks before it sends the 2 tiny test messages.
- New: Bring my projects from Orca. After you click, Potato reads Orca's project list on this PC and adds the ones you pick. Five more agents are listed in the store (names and commands from Orca's open-source list, with credit).
- New: when an agent updates, Potato checks it again. If its chat stops working, its Settings page says so and offers Check it again.
- When an agent stops unexpectedly you see one clear message instead of several. Very long answers and very long runs say what was hidden instead of cutting it silently. A reopened chat no longer shows an old answer as new. A question answered in another window says "Already answered".
- The More menus open fully on top of everything, the pane header folds instead of cutting words off, chats have one header row, and the message box chips say what they set.
- Smaller fixes: one chip style everywhere, Settings > Connect as four cards, plain words on team cards, Bring my chats says why an agent is missing, and the phone address is no longer shown in a text box.

## 1.0.21

This is a beta.

- New look: warm charcoal with a little colour that means one thing each. Orange is your move (Needs you, Send, where you are), green is working, yellow is risk, red is broken.
- Sidebar: each project is a card with its branch and how much changed; an agent's icon carries a small dot for working, needs you or error; the footer is one row (Settings, Review, more).
- Inbox: one flat list. Each item shows the agent's icon and what kind of ask it is (Question, Permission, Stopped, Done), with a one-line heading.
- Agent panes: a one-row header, tabs for the agents in the same project (with a dot when one is working or needs you), a plain side panel, and Changes with added and removed line counts.
- Status bar: each agent's usage under its own icon with a small meter; it turns yellow from 80% and red when a sign-in expired, and shows how many agents are working or need you.
- Chat reads like a document, and the message box shows a yellow shield only when the agent has full access.
- New agent page: one question, three starters to try, and Start once you type.
- One empty-state style, one type scale, and the same hover, selected and focus look everywhere.

## 1.0.20

This is a beta.

- New: Add an agent in one box. Type a name; Potato finds the program, checks its version and says hello to it, with no model calls. Agents that only work in a terminal are added as terminal agents. Installs ask once first.
- New: Found on this computer. The Add an agent box lists agents already installed, with Add and Add all.
- New: every agent shows what it can do (chat, remember, pick a model, ask before changes). A tick only appears when it was proven; the rest say "Not seen yet" until a chat shows it.
- New: Settings opens on an Overview (agents, sign-ins, phone, updates, helpers) and has eight plain pages, search with everyday words, a page per agent, a dot on what you changed, Reset per row and Undo.
- New: agent icons. Each agent shows its own icon instead of a dot, in the sidebar, usage bar, New agent page and Settings; the working and needs-you marks sit on the icon.
- New: OpenCode spend (today and the last 7 days, per model) in the usage bar, read from OpenCode's own files on this PC.
- The New agent page lists the same models as the chat, with descriptions, once the agent has reported them.
- Chats: an agent that stops on its own is shown as an error, not a success; agents that only send models or modes get a working picker; Python agents get UTF-8 output.
- Safer setup checks: a help text can no longer turn on a skip-permissions flag through a short alias, a model list command is checked before it runs, and a resumed chat stays in its own project.
- Smaller fixes: one count for running jobs, no "Connection lost" before the first connect, readable usage wording, plain Inbox words, delete asks first in Closed chats, and the Shortcuts sheet has a title.

## 1.0.19

This is a beta.

- New: Settings > Agents > Default model. Pick the model each agent starts on, in chats and terminals. The New agent page starts on it, and the Default model for helpers still wins for helpers.
- New: Get early versions (beta) in Settings > Updates. Settings are backed up (the last five), and Restore the last good settings brings them back.
- Terminal agents now close with the app instead of running on unseen. After a crash, the next start cleans them up, and a run that was ended offers Reopen.
- A chat no longer gets stuck at "Waiting for you" with nothing to press. A permission question is always shown with buttons, and one that can't be shown is turned down so the agent moves on.
- Borrowed Claude sign-ins work in chats, not only in terminals. The lend note explains that a borrowed sign-in is billed like an API key on the lender's side.
- A background-task message from Claude Code shows once as a small notice, not twice as raw text.
- OpenCode helpers: chats survive an app restart for the agent that started them, a stale helper model is dropped with a note instead of failing, and OpenCode's own errors are shown in plain words.
- Helpers (MCP): run several at once with run_agents (up to 8 by default, a setting), ask another agent to review a result with review_by, and the app can answer a helper's read and search questions for it (edits and commands still wait for you). Read-only runs prove the project folder did not change.
- Helpers (MCP): the lane is now a hint. If a chat can't honour read-only or a model, the terminal runs it and the answer says what changed. Every refusal includes a call that works.
- Helpers (MCP): the MCP can start the app in the tray when it isn't running. Results can be brief, and every answer says what was and wasn't checked.
- Errors show as plain sentences everywhere, and the app keeps a private log file (secrets removed) that goes into the diagnostic zip.

## 1.0.18

This is a beta.

- Security: the app's local connection now trusts only the app's own window. Before, a web page served from any localhost address (for example a project's dev server) could control agents without a token.
- Helpers asked to be read-only now really are in chats too. OpenCode switches to its plan mode, and file edits and commands are refused. When a request can't be done, the message says which call works instead.
- The MCP tool list is about 70% smaller, the "app and MCP are different builds" warning shows once per changed tool instead of on every call, and waiting for helpers can last up to an hour in one call.
- A pre-started agent stuck at a sign-in screen is no longer restarted every 30 seconds. It tries 3 times, then waits until you sign in.
- Settings is simpler. Focus Time, the Recorder, Clip It, Tag Your Agent, the moving tray icon and the old built-in orchestrator are gone. New: Discord alerts, and Uninstall everything in a Danger zone.
- Team shows "Couldn't check who is online" instead of a raw error when a ping fails.
- Plainer words: "Always for this agent", "Untitled chat", "background tasks", "replies" instead of "turns", "New PowerShell terminal", capitalised model names.
- Bring my chats has one Bring button and says why an agent's chats can't be read. The usage bar says "Not shared" instead of "Unknown".
- "Connection lost" only shows after a real drop, not on a fresh install.

## 1.0.17

This is a beta.

- New agents start as a chat by default (a terminal when the agent has no chat). The New agent page remembers your last choices: chat or terminal, agent, sign-in, model and project.
- The New agent page has a model picker. Settings has a default model for helpers, per agent. Shells like PowerShell are no longer listed there.
- A chat picks its model in this order: the one asked for, the helper default (helpers only), your setting, your last pick, then the agent's own default.
- Starting a chat shows a "Starting" view at once instead of waiting with nothing on screen.
- Copy a file in File Explorer and press Ctrl+V in a chat: it is attached, like the attach button. Several files and folders work too.
- A usage bar along the bottom shows each sign-in's usage, with agent logos.
- Lend through my PC (Labs): lend your Claude sign-in or API key, or a Codex or Gemini API key, to a teammate. The login stays on your PC. Codex signed in with ChatGPT says "not supported yet".
- Lending works across countries and different internet: it uses a relay when a direct link fails, reconnects by itself after a drop or a restart of the lending PC, and waits longer on slow links. Test link checks a lend end to end and says what works. Team shows pings for each teammate.
- The PC stays awake while you lend and while agents work.
- Helpers start as chats by default, and chats start faster with warm sessions.
- Hand off does a Quick handoff or a handoff to a new agent.
- Bring my chats reads OpenCode 2 chats, opens old chats much faster, and the page loads faster when you open it again.
- OpenCode 2 runs in the chat. Its terminal starts without the flags 2.x no longer has, and a billing or credit problem is shown in plain words.
- MCP: long waits in one call, discard closes the pane first, closed helpers can be reopened, and cleanup tools are in the default set.
- Fix: a team relay no longer answers a reconnecting device with "too many requests".

## 1.0.16

This is a beta.

- Team: a new Team page in Settings. Start a team or join one by pasting an invite: your name is filled in and joining is one click. The page shows Connecting, Connected or what is wrong, the invite comes with a QR code, and people waiting to join get Let in and Decline right there.
- Team: Create team relay puts a free relay in your own Cloudflare account from a pasted token. The token is used once and not kept.
- Team: War Room events in Inbox, Team. Pushes to main and new PRs from teammates show up, and when CI on main fails a "main is red" banner lets one person Claim it.
- The welcome now takes you from install to a first result in four steps: pick agents, connect them, pick a project, then watch Claude hand a review to Codex. If the agent answers by itself instead, it says so, with Try again.
- Warm Codex helpers no longer die at start. Codex's update menu is skipped for that launch, and nothing is installed.
- Keyboard shortcuts are now yours to change. Settings, Shortcuts lists every shortcut: change it, turn it off or reset it. You get a warning when keys clash with another shortcut or with keys terminals need. The Ask bar, Stop all and the mode switch can use your own keys too, and if the system refuses a key the old one stays and Settings says why.
- New keys: Alt+Shift+Down and Up move between agents, Alt+Shift+1 to 9 jump to one, Alt+Shift+N goes to the next agent that needs you, and Alt+Shift+I opens the Inbox (Cmd+Option on a Mac). The command palette lists agents that need you first, then the one you used last, and has Inbox, next and previous actions.
- The app opens on the pane and tab you left. If terminal agents ended with the restart, one line says so, with Reopen (starts each again in its folder) and Dismiss. Chats still come back on their own.
- After you answer an Inbox card with a key, focus moves to the next card and "Next: agent" shows for a few seconds. The pane approval card shows its keys.
- An agent with several sign-ins starts under the one you used last, with no extra step. Shift+Enter, Shift+click or a small Change button picks another. The usage-limit card has "Use another sign-in".
- The update notice shows progress ("Downloading 42%"), then Restart now or When agents finish. It names the agents that will stop and says chats come back but terminal agents are not reopened. If the install fails after agents were stopped, it says so and offers Reopen chats.
- The terminal keeps your place while an agent prints. Scroll up and a "Jump to latest" button appears. The terminal font adds SF Mono and Menlo, and Option works as Meta.
- The welcome is a real dialog: Tab stays inside it, Esc works the way the footer says, and the app behind it is not reachable. Step 1 is shorter, "How do you work?" moved to the last screen, the two skip buttons are one "Skip for now", and the last step shows a plain summary with the exact words one click away.
- Sign-in and Check my setup are now in the basic Agents settings. Agent definitions moved to advanced.
- An empty Inbox leads with "Start an agent", and the Focus timer stays hidden until an agent has run. The sidebar footer shows text labels and "Review · N" in wide windows, Settings has its own icon, and rows that need you are read out as "Agent, needs you".
- One set of words everywhere: "agent" instead of "AI helper", "sign in" instead of login and account, and "Chat" instead of "Chat (ACP)". The Puppet Master name is gone from visible text.
- The mini bar shows the agents' real names and puts the ones that need you first. The New agent page says "New agent", shows its question over the box, and explains cards once.
- On a Mac, Ctrl+K, Ctrl+Shift+F, Ctrl+/ and the split key use Cmd only, and the Mac defaults for Ask bar and mode switch no longer use Ctrl+Alt+Space, which macOS uses to switch input source. A plan for the full Mac port is in docs/plans/macos-port.md.
- Fix: opening a link no longer goes through a command shell. Only http and https links open, so a link with & or | can't run commands.
- Fix: a locked or damaged settings.json is no longer overwritten with just the newest change. The save is refused and a damaged file is kept as settings.json.bak. Clearing a setting now resets it to its default.
- Fix: removing an account can no longer delete folders outside the app's own accounts folder, even if its folder was set with ".." in the path.
- Fix: the MCP tools and the CLI no longer read the app's address from the current folder, and only connect to this computer.
- Fix: the local bridge and the phone server refuse oversized requests, time out slow ones and limit open connections.
- Fix: a refused pane lease no longer shows another session's id.
- Fix: pairing codes are checked in constant time and dropped after 5 wrong guesses.
- Fix: Settings shows the real version, and the phone input delay default is the same everywhere.
- Fix: a failed save no longer shows "Saved" or clears what you typed, and a typed API key is no longer lost when secure storage is off. Ask bar and stuck-warning settings put the old value back.
- Fix: a rejected account rename goes back to the saved name, a failed refresh keeps the list and shows an error, and the public address panel shows an error instead of failing silently.
- Fix: Settings, Agent definitions no longer shows "Cannot read properties of null".
- Fix: cancelling a headless run while it is starting now stops it instead of letting it run on and edit files.
- Fix: closing a chat while its adapter is starting no longer leaves a hidden process running.
- Fix: long headless runs keep their session, so a follow-up can resume. A stuck or unwatchable process is force-stopped, and an unused warm process is stopped when its run is cancelled.
- Fix: a chat turn that can't start no longer leaves the chat refusing every later message.
- Fix: a restarted pane's old exit no longer revokes the new pane's hooks or reports it as exited.
- Fix: terminal output without line breaks no longer grows memory without limit, a failed pane start no longer leaves its process running, closed panes leave nothing behind, typing no longer holds up other panes, and two quick resizes no longer leave the grid the wrong size.
- Fix: two writers can no longer corrupt the event log. Unreadable lines are skipped, recent events are read from the end of the file, and the log rotates at 32 MB.
- Fix: a terminal whose history can't be read now retries, then goes live, instead of showing nothing.
- Fix: Update now checks again after the download for agents that are working or waiting for you, and only stops agents just before the installer runs.
- Fix: the bridge answers refused requests reliably instead of sometimes resetting the connection on Windows.
- Fix: the personal-folder guard passes, and an ACP chat test that failed now and then waits for the journal to settle.

## 1.0.15

- Switching between Orchestration and Individual now moves your agents: each pane flies to its own window and back, including agents that are only in the sidebar. Pick Domino, Ink or Off (a quick fade) in Settings, General, Mode switch animation, and press Preview to see it. With Windows animation effects off it just fades.
- Individual mode puts the windows side by side at their normal size, in rows under the mini bar, with your active agent first and nothing overlapping. Pick Cascade in Settings, General, Window layout in Individual for the old step-down look.
- The mini bar scrolls when you have many agents, grows to fit them first, and each agent has a small × to close it.
- Fix: the More menu on a pane no longer opens off the left edge of the window.
- Fix: helpers started from a chat now sit under that chat in the sidebar and count as its helpers. Before, a chat restored when the app started could lose track of its helpers, so they showed as normal agents.

## 1.0.14

- Chat (ACP) agents get a real chat pane, in the main window and in their own window. No more "no terminal" message: the pane shows the agent, project, login and status, the conversation with its questions, a composer, and a short result (files changed and the agent's summary).
- Warm agents now follow the project you work in: your last run or the pane you click. When you switch projects, the new folder is warmed first and the old one is closed only after that. A folder the agent hasn't trusted yet stays cold, and Settings says why.
- A new warm agent starts as soon as one is used.
- Claude now uses Potato Workspace's run_agent for delegated work instead of its own subagents, and our tools stay loaded in projects the app sets up.
- Tools that only work on a terminal now say so clearly when used on a chat pane, and point to the right tool.

## 1.0.13

- Individual mode no longer looks like a crash. A small bar stays at the top of the screen with your agents, "+ New" and "Back to Orchestration", even with no agents open. After a switch you get 8 seconds to undo, and the first switch explains what will happen. The mode switch is now a clear Orchestration | Individual toggle, the tray icon brings your agent windows back, and Ctrl+Alt+M switches modes (if no other app uses it).
- Starting in Individual mode with no agents opens the main window instead, with a "Switch back" button.
- Helpers can run as chat (ACP) agents: with Chat (ACP) on in Labs, helpers use it when the agent supports it, and the result says which way they ran. Choosing Terminal in Settings is always kept.
- Chat (ACP) agents can run under a saved login, like terminal agents.
- "Run helpers on" picks which login your helpers use, per agent. Panes show which login they run under.
- OpenCode supports more than one login.
- MCP is sturdier: it finds the app again after a restart (on any port), waits for a restarting app instead of failing, stops waiting when you cancel, never starts a second run when a call is retried, and every error says whether to retry and how to fix it.
- A run cut off by an app restart can be continued with a follow-up instead of being lost. Two callers can no longer take over the same pane at once.
- Helpers end their answer with a short structured summary (files changed, checks run, open questions). The default MCP tool list is shorter: 10 core tools, with the rest still callable.

- Helpers now close with the agent that started them. Close an agent and its helpers (and their helpers) close too. Turn this off in Settings with "Close helpers when their agent closes".
- New "Closed chats" list at the bottom of the sidebar. Reopen a closed chat with its history, or delete it for good.

## 1.0.12

- Fix: your chats now come back after you quit the app or install an update. Before, quitting or updating counted as closing every chat, so they disappeared from the sidebar (they were still saved). Only closing a chat yourself closes it now.

## 1.0.11

- The New agent button (and Ctrl+N) opens the full New agent page again. The small arrow next to it opens the quick menu.
- The New agent page has a Project picker: your saved projects, folders of running agents, "Add project..." and "Choose another folder...". It remembers the last project you used.
- The + on a project in the sidebar opens the New agent page with that project already chosen.

## 1.0.10

- New sidebar: your agents are grouped under projects. Add a project, start a "+ New agent" inside it, and fold a project away. Agent rows are slim, one line each. Group by project or by status, with Pinned on top.
- A "New agent" button (Ctrl+N) and a Search row now sit at the top of the sidebar.
- Agents waiting for you now show a "Needs you" label.
- You can hide agents you don't use from the New agent menu ("Edit list...").
- "Hand off from here" / Hand off button: the agent writes a HANDOFF.md, then a new agent of the same kind and model picks it up.

## 1.0.9

- Fix: after an install or update, Windows started Potato Workspace with a restriction that stops it following links, so agents installed through links (like Codex) failed with "No application is associated with the specified file". Potato Workspace now restarts itself without that restriction, and if it can't, tells you to reopen it from the Start menu.
- Fix: Codex in the Chat tab now gets Potato Workspace's tools (they were dropped when Codex's own settings had an entry with the same name).
- Fix: Codex started with "never ask" approvals can now use Potato Workspace's tools; only Potato Workspace's own server is pre-approved. "Add Potato Workspace to your agents" offers to add this to existing Codex settings, with Undo.

## 1.0.8

- Fix: agents in a Terminal pane failed to start with "No application is associated with the specified file" when the first matching program on PATH was a broken link (for example during a Codex self-update or after a winget upgrade). Potato Workspace now starts the first program that can actually run, by its full path, and says which files it tried if none can.
- Fix: the setup check now finds agents installed with winget, and winget's "already installed / no upgrade" answer counts as success instead of an error.

## 1.0.7

- Fix: chats in the installed app now get Potato Workspace's tools (the app looked for its tool program in the wrong folder). A chat says so if the tools can't be added. Same folder fix for phone pairing and agent adapters.
- Fix: "Add Potato Workspace to your agents" repairs the connection 1.0.6 wrote that pointed at a program that doesn't exist.
- Helper agents setting: Always show them (default), Let the agent choose, or Always run in the background. "Keep helpers open when they finish" is on by default.
- Stop is now the send button; the Working bar is gone.
- Pin chats to the top of the list.
- + menu: Add files, Add folder, Add image. Folders show as a chip with a file count.
- Set up any agent by choosing its settings file (and skills folder), including agents Potato Workspace doesn't know.

## 1.0.6

- New chat look: a decision card for permission asks (Allow or Deny, with "Don't ask again in this chat", hold to allow for deletes and moves, and answered asks fold to one line). Agent thinking is shown and folded. Tool calls show as cards with a status. Terminal output has Copy, change cards have Copy patch, and there is a live step list with a timer, plan progress, code block headers, and Copy and Retry under replies.
- New message box: one card with model and mode menus, an effort switch, a context ring and stacked queued messages.
- "Add Potato Workspace to your agents" now also sets up custom agents and store agents (Gemini CLI, Qwen Code, Copilot CLI, Droid, Auggie, Kimi Code, Kiro; Mistral Vibe gets skills only). It lists the agents it cannot set up, with the reason.

## 1.0.5

- Chat messages show added files as chips instead of pasting file text into the message. Paste images with Ctrl+V. Type @ to add a project file.
- Files reach the agent as real attachments: images as images when the agent supports them, other files as file links or file contents.
- Fixed: 1.0.4 did not bring over data from 1.0.3. On first start, 1.0.5 copies your 1.0.3 data once. It only fills in missing files and never changes the old folders.
- Fixed: Potato Workspace now uses its own ports (17421-17499) so it does not clash with Puppet Master.
- Security fixes for the local bridge, the proxy marker and checkpoint restore.

## 1.0.4

- Potato Workspace is fully separate from Puppet Master: its own tool server, skill pack, ports, data folders, companion folders and release uploads.
- Existing data in the old folders is copied once into Potato Workspace's own folders; the originals are left untouched.
- Chat helpers now apply the requested model and reasoning before the first message, and report the model actually in use instead of silently using another one.
- Helpers started from a chat are nested under the chat that started them, the same as terminal helpers.
- Fixed: a helper chat now keeps its starter and its parent pane across an app restart. The link is saved with the conversation, so a restored chat stays nested under its parent and its starter keeps owner-only control. Older saved conversations still load.
- Chat replies now report background work separately from the turn: `wait_agents` keeps waiting while reported background tasks run, and `background_tracking` says when an agent cannot report them.
- Every permission prompt now records why it ended (`answered_by_person`, `answered_by_agent`, `cancelled`, `turn_ended`, `session_ended`), and `wait_agents` can confirm that a prompt is stable with `confirm_prompt_ms`.
- `wait_agents` replies also include how long a prompt has been open and the last prompt that ended.
- Chat messages can now attach files: the + button (or dropping files on the message box) takes several at once, puts text and code file contents inline, and copies images, PDFs and other binary files into `.potato-workspace/attachments/` so both terminal and chat agents can open them.
- `wait_agents` now recognises a finished chat helper and returns its final reply once, instead of asking again with no pause. It also waits a short quiet window after reported background work drains so a later reply is not missed, paces retries when a wait slice returns early, and reports a local connection failure as `bridge_unreachable` (“the bridge may still be running”) instead of `bridge_down`.

## 1.0.3

- Helpers now show in the sidebar. Agents can no longer hide them unless you turn on Allow hidden helpers.
- The model and effort you ask for are now what the helper runs on.
- Read-only helpers work in a visible pane.
- Trust this folder now works on the screen that lists pre-approved tools.

## 1.0.2

- Agents installed while the app is open now work without restarting the app.
- Helpers can use a different login: choose it in Settings, or pick it on a card.

## 1.0.1

- Update test release: no changes to the app.

## 1.0.0

- First release of Potato Workspace: agents, panes, terminal and chat in one app.
- Installer includes Node.js, npm, Git and cloudflared.
- One-click updates from GitHub Releases.

## 0.1.5 - security patch

- Fixes a bridge authorization bypass: requests that came through a tunnel, a reverse proxy or a
  web page were trusted as the desktop app and needed no paired-device token. All earlier
  releases (0.1.0 to 0.1.4) are affected; update. Details and what to do:
  `docs/security/2026-10-14-tunnel-auth-bypass.md`.

## 0.1.2 — PWA fixes and MCP publishing

- Mobile PWA bug fixes and polish
- MCP server publishing workflow (`@puppet-master/mcp`)

## 0.1.0 — initial scaffold


- Monorepo: `@puppet-master/{shared,cli,bridge,mcp,app}` workspaces
- Tauri 2 + React + xterm.js desktop app
- Rust PTY manager with `portable-pty` (Windows ConPTY)
- 5 MCP tools: `list_panes`, `spawn_agent`, `read_terminal_buffer`, `write_terminal_input`, `kill_pane_process`
- Local HTTP bridge (Node stdlib) with SSE event stream
- Built-in Puppet Master LLM chat (Anthropic + OpenAI) using the same MCP tools
- Settings panel for API keys + model picker (Anthropic / OpenAI)
- Status heuristics: `running` / `waiting_input` / `idle` / `error`
- Unit tests: 6 scrollback buffer tests passing
- Bridge smoke test: `scripts/test-bridge.ps1`
- MCP smoke test: `scripts/test-mcp.ps1`
