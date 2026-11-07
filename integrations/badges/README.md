# README badges

## Add to Cursor (works today)

```markdown
[![Add Potato Workspace to Cursor](https://img.shields.io/badge/Cursor-Add_Potato_Workspace_MCP-black?logo=cursor)](cursor://anysphere.cursor-deeplink/mcp/install?name=potato-workspace&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBwb3RhdG8td29ya3NwYWNlL21jcCJdfQ%3D%3D)
```

GitHub strips custom URL schemes from Markdown links, so a repository README needs the HTTPS redirect page below. In docs, the link works as is. The `config` value is the base64 of `{"command":"npx","args":["-y","@potato-workspace/mcp"]}`. Until a current `@potato-workspace/mcp` is published (see `../README.md`, Known gaps), prefer the in-app installer.

## Run in Potato Workspace (planned)

```markdown
[![Run in Potato Workspace](https://img.shields.io/badge/Run_in-Potato_Workspace-black)](https://github.com/Potato-dev-inc/potato-workspace/releases)
```

This snippet links to the installers, which works today. The "open this repo in Potato Workspace" behaviour needs two things that do not exist yet: the `potatoworkspace://open?repo=<git url>&ref=<branch>` deep link in the app, and an HTTPS redirect page that opens it and falls back to the installer. When both ship, change only the link target to that page.

## Works with Potato Workspace

```markdown
[![Works with Potato Workspace](https://img.shields.io/badge/Works_with-Potato_Workspace-black)](https://github.com/Potato-dev-inc/potato-workspace)
```

Only for agents that ship a Potato Workspace agent definition; the claim should be backed by a conformance run, not made by default.
