# Use Potato helpers inside Orca

Orca runs your coding agents in its own terminals. If you also use Potato Workspace, you can give those agents the
Potato Workspace tools, so an agent in Orca can hand a small job to another agent (a second opinion, a review, a
side task in its own copy of the project) and read the answer.

You need: Potato Workspace installed and open on the same PC, and Node.js (the snippet below starts the helper
with `npx`).

## Steps

1. Open the project folder you work on in Orca (the folder at the top of the project, not a subfolder).
2. Make a file named `.mcp.json` in that folder. If one is already there, add the `potato-workspace` part to the
   `mcpServers` list that is already in it and keep the rest.
3. Paste this:

```json
{
  "mcpServers": {
    "potato-workspace": {
      "command": "npx",
      "args": ["-y", "@potato-workspace/mcp"]
    }
  }
}
```

4. Start a new agent in Orca in that project. Agents that read `.mcp.json` (Claude Code does) show the Potato
   Workspace tools and ask you before they use them the first time.
5. Ask the agent something like: "Ask another agent to review this change, then tell me what it said."

## Notes

- Agents that keep their tool list somewhere else (Codex, Cursor, OpenCode) need the same entry in their own
  settings file. The `integrations` folder of Potato Workspace has a ready file for each.
- Potato Workspace must be running. If it is closed, the tools answer that the app is not reachable.
- Helper agents you start this way show up in the Potato Workspace sidebar, so you can watch them there.
- Orca and Potato Workspace do not share logins or chats. Nothing is sent from one to the other except the
  tool calls the agent makes.
- To bring your Orca projects into Potato Workspace, open Bring my chats and press "Bring my projects from Orca".
  Orca's files are only read, never changed.
