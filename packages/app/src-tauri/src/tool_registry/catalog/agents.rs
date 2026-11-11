//! Catalog entries: Agent runs, workers, ownership and sessions.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "set_mode",
            description: "Choose which MCP tool catalog this connection can call: agent, shell, or both. The default list shows only the core tools of the chosen mode; mode=all is both plus a full list that also shows aliases and advanced tools (reconnect, OpenCode, task board, session context), which stay callable by name in every mode that allows them. The selection is isolated to this MCP connection.",
            input_schema: object_schema(json!({"mode":{"type":"string","enum":["agent","shell","both","all"]}}), vec!["mode"]),
            output_schema: Some(json!({"type":"object","properties":{"mode":{"type":"string","enum":["agent","shell","both","all"]},"tool_count":{"type":"integer","minimum":0}},"required":["mode","tool_count"]})),
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(),
            method: "POST",
            path: "/mcp/mode",
        },
        ToolDefinition {
            name: "quick_ask",
            description: "Ask a tiny one-shot question and get just the answer, like a native subagent call. Runs a fresh headless read-only worker (no checks, no shell, pane closed afterwards) on the first installed backend (claude, codex, cursor_agent) unless `backend` says otherwise. Returns {answer, receipt}; receipt.not_verified lists what was not verified. If it is still running after wait_ms (default 90s, max 120s) it returns {status:\"running\", handle, hint:\"wait_agents\"}: call wait_agents(handle). For real work, checks, or follow-ups use run_agent.",
            input_schema: object_schema(json!({"task":{"type":"string"},"project_path":{"type":"string"},"backend":agent_type_schema(),"model":{"type":"string"},"wait_ms":{"type":"integer","minimum":0,"maximum":120000,"default":90000},"read_only":{"type":"boolean","default":true,"description":"Defaults to true. Only pass false when the question needs the agent to write."},"idempotency_key":{"type":"string"}}), vec!["task"]),
            output_schema: Some(json!({"type":"object","properties":{"answer":{"type":["string","null"]},"receipt":receipt_schema(),"status":{"type":"string","enum":["running","needs_input"]},"handle":{"type":"string"},"hint":{"type":"string"},"prompt":{"type":["object","null"]}}})),
            safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/quick",
        },
        ToolDefinition {
            name: "run_agent",
            description: "Launch and wait: run_agent({agent_type:\"codex\", project_path:\"D:/repo\", task:\"...\", wait_ms:1800000}) returns the result in this call when the turn ends within wait_ms (default 120000, max 3600000; hosts like Claude Code move a long call to the background and hand you the result when it ends). If it is still running you get a handle plus a watch_command to run in a background shell. Use it instead of a built-in subagent for anything beyond quick_ask. The worker gets its own visible pane: do not pass headless (the person chooses in Settings > Agents). Next: followup_task(handle, task), wait_agents(handles), send_message(handle) to steer. On WAIT_TIMEOUT retry with the same idempotency_key (minted if omitted); never start a duplicate turn. Cleanup: close_agent(handle); with isolation=worktree use review_worktree(handle, action:\"diff\"|\"merge\"|\"discard\"). keep_pane=true keeps the pane open; pane_note says when the person's Keep helpers open setting did. Fields marked Advanced: are rarely needed (see the potato-workspace skill, section Advanced run_agent options).",
            input_schema: object_schema(json!({"project_path":{"type":"string"},"task":{"type":"string"},"name":{"type":"string"},"handle":{"type":"string"},"worker_id":{"type":"string"},"agent_run_id":{"type":"string"},"agent_type":agent_type_schema(),"headless":{"type":"boolean","default":false,"description":"Leave out: the person chooses in Settings > Agents > Helper agents (shown by default, so true is ignored and reported as headless_ignored)."},"background":{"type":"boolean","default":false},"wait_ms":{"type":"integer","minimum":0,"maximum":3600000,"default":120000,"description":"How long this call waits for the turn to end. Above 300000 it keeps waiting inside the call; if still running at the end you get a handle and watch_command."},"read_only":{"type":"boolean","default":false,"description":"No edits and no commands; refused with READ_ONLY_UNSUPPORTED where the agent cannot (list_agents read_only_supported)."},"placement":{"type":"string","enum":["auto","grid","window"],"default":"window","description":"Advanced: where a visible pane opens (window = own pop-out, grid/auto = main window grid)."},"lane":{"type":"string","enum":["auto","acp","terminal"],"description":"Advanced: left out = a chat when the agent has one, else the terminal; read_only, isolation, locks and other terminal-only options use the terminal. The result reports lane_used."},"isolation":{"type":"string","enum":["none","worktree"],"default":"none","description":"worktree: own git worktree on branch pm/<handle>; review with review_worktree(handle, action). Needs a git repo with a commit; not with pane_id or worker_id."},"keep_pane":{"type":"boolean","default":false,"description":"Keep the pane after the run (close_agent(handle) closes it). Otherwise it closes on completion unless the person keeps helpers open; see pane_note."},"timeout_ms":{"type":"integer","minimum":1,"maximum":86400000,"default":900000},"idempotency_key":{"type":"string"},"shell":{"type":"string","enum":["bash","powershell","cmd"],"description":"Advanced: shell the printed watch_command targets."},"structured_result":{"type":"boolean","default":true,"description":"Advanced: false skips the potato-result JSON block."},"acceptance_criteria":{"type":"array","items":{"type":"string","minLength":1},"description":"Advanced: free-text guidance, not machine-checked; use checks for verified acceptance."},"checks":{"type":"array","maxItems":20,"description":"Acceptance checks run at completion; a failing one fails the run with ACCEPTANCE_FAILED. command_exits runs argv (no shell) in project_path; paths are relative to it.","items":{"type":"object","properties":{"type":{"type":"string","enum":["file_exists","file_contains","file_absent","result_contains","command_exits"]},"path":{"type":"string","minLength":1,"description":"Required for file_* checks."},"text":{"type":"string","minLength":1},"command":{"type":"array","items":{"type":"string"},"minItems":1,"description":"command_exits: argv, e.g. [\"python\",\"-m\",\"pytest\",\"-q\"]."},"expect_exit":{"type":"integer","description":"command_exits: expected exit code (default 0)."},"timeout_ms":{"type":"integer","minimum":1,"maximum":600000,"description":"command_exits: default 120000."}},"required":["type"]}},"pane_id":{"type":"string"},"allow_broad":{"type":"boolean","default":false},"trust_workspace":{"type":"boolean","default":false,"description":"Advanced: headless cursor_agent only: pass --trust for a folder the user named."},"allow_shell":{"type":"boolean","default":false,"description":"Advanced: headless cursor_agent only, not read_only: pass --force so shell commands run; pair with checks."},"allowed_commands":{"type":"array","maxItems":10,"items":{"type":"string","minLength":1},"description":"Advanced: visible cursor_agent only: program names or argv patterns answered allow-once."},"context_policy":{"type":"string","enum":["fresh","packet","parent_summary","resume","selected_history"]},"context_mode":{"type":"string","enum":["fresh","packet","parent_summary","resume","selected_history"],"description":"Advanced: alias for context_policy."},"model":{"type":"string","description":"Model the worker runs on; the receipt shows the one that ran."},"reasoning":{"type":"string","description":"Reasoning effort (low, medium, high) where supported."},"role":{"type":"string"},"scope":{"type":"string"},"selected_history":{"type":"array","items":{"type":"string"}},"account":{"type":"string","description":"Advanced: account id from Settings > Agents > Accounts (ACCOUNT_NOT_FOUND, ACCOUNT_UNSUPPORTED)."},"locks":{"type":"array","items":{"type":"string","minLength":1},"description":"Advanced: resource locks (type:name) held for the run; RESOURCE_LOCKED if taken."},"budget_turns":{"type":"integer","minimum":1,"maximum":10000,"description":"Advanced: pause a NEW run before its next turn after this many turns (followup then fails with BUDGET_EXHAUSTED)."},"budget_minutes":{"type":"integer","minimum":1,"maximum":10080,"description":"Advanced: wall-clock minutes for a NEW run; same pause rule."},"budget_parent":{"type":"string","description":"Advanced: filled in for you under a budget; leave out."},"until_checks_pass":{"type":"boolean","default":false,"description":"Advanced: preview mission mode (Settings > Labs, else MISSIONS_OFF); needs checks with command_exits, a budget and a visible pane."},"backup_agents":{"type":"array","maxItems":4,"items":{"type":"string","minLength":1},"description":"Advanced: with until_checks_pass, agents to hand the mission to when stuck (agent_type or agent_type@account)."}}), vec!["task"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/run",
        },
        ToolDefinition {
            name: "wait_agents",
            description: "Wait for worker handles. Default until is completed, failed, cancelled, and needs_input (progress revisions do not wake). A completed turn is not always finished work: when the adapter reports background tasks still running, wait_agents keeps waiting by default; pass wait_for_background=false for the old turn-only result. Before treating waiting_input as a stable block, pass confirm_prompt_ms (e.g. 3000): the call then returns only if the same prompt_id is still open after that window. The reply carries prompt.since_ms/prompt.open_ms and last_prompt {prompt_id, reason} so you can tell why a prompt ended. background_running/background_task_count/background_tracking say whether the agent reports background work. Pass wake_on_progress=true to wake on any revision. Omits result when unchanged since after_cursor (result_unchanged). Default and maximum timeout_ms is 120000: MCP hosts commonly abandon a call after 2-3 minutes (Request timed out) and a timeout never drops ownership, so loop wait_agents for longer runs. A chat helper returns here when its turn finishes, including after reported background work. If the call fails with bridge_unreachable, the app may still be running and the helper may already have replied: retry, then read agent_transcript or the pane before saying you got no reply.",
            input_schema: object_schema(json!({"project_path":{"type":"string"},"handles":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}},"after_cursor":{"type":"integer","minimum":0},"after_revisions":{"type":"object","additionalProperties":{"type":"integer","minimum":0}},"until":{"type":"array","items":{"type":"string","enum":["queued","starting","running","waiting_input","needs_input","cancelling","completed","failed","cancelled"]}},"wake_on_progress":{"type":"boolean","default":false},"timeout_ms":{"type":"integer","minimum":0,"maximum":120000,"default":120000},"mode":{"type":"string","enum":["any","all"],"default":"any"},"wait_for_background":{"type":"boolean","default":true,"description":"Default true: a completed turn does not count as a hit while the adapter reports background tasks still running. false restores the old turn-only behaviour."},"confirm_prompt_ms":{"type":"integer","minimum":0,"maximum":60000,"default":0,"description":"0 (default): one waiting_input reading counts as a hit. More than 0: waiting_input counts only if the same prompt_id is still open after this many milliseconds, so a transient prompt cannot be reported as a block."},"shell":{"type":"string","enum":["bash","powershell","cmd"],"description":"Shell that will run watch_command (default: valid in both PowerShell and Git Bash)."}}), vec!["handles"]),
            output_schema: Some(json!({"type":"object","properties":{"agents":{"type":"array","items":agent_run_schema()},"reason":{"type":"string"},"mode":{"type":"string","enum":["any","all"]}},"required":["agents","reason","mode"]})), safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(), method: "POST", path: "/agents/wait",
        },
        ToolDefinition {
            name: "send_message",
            description: "Deliver a correction or steering message to the current turn. Returns a receipt with state accepted|queued|processed|deferred|unsupported|expired|rejected. accepted means the native session took the message; processed is set when the next assistant reply is recorded. Steering a finished turn returns rejected and suggests followup_task. Never injects arbitrary text into a busy TUI. delivery=live_or_queue (default).",
            input_schema: object_schema(json!({"handle":{"type":"string"},"message":{"type":"string","minLength":1},"task":{"type":"string","minLength":1},"delivery":{"type":"string","enum":["live_or_queue","live","queue"],"default":"live_or_queue"},"idempotency_key":{"type":"string"},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(json!({"type":"object","properties":{"message_id":{"type":"string"},"idempotency_key":{"type":"string"},"disposition":{"type":"string","enum":["accepted","accepted_via_restart","queued","processed","deferred","unsupported","expired","rejected"]},"state":{"type":"string","enum":["accepted","accepted_via_restart","queued","processed","deferred","unsupported","expired","rejected"]},"handle":{"type":"string"},"turn_id":{"type":"string"},"result":{"type":["string","null"]},"suggestion":{"type":"string"},"next_cursor":{"type":"integer"},"last_steer":{"type":"object","properties":{"message_id":{"type":"string"},"state":{"type":"string"},"turn_id":{"type":"string"}}}},"required":["message_id","disposition"]})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/send",
        },
        ToolDefinition {
            name: "followup_task",
            description: "Give the same worker a new task as the next turn. Same wait as run_agent: wait_ms (default 120000, max 3600000) waits inside this call and returns the settled turn (status/result); above 300000 it keeps waiting in the call. If status is still running you also get a watch_command, and wait_agents recovers the answer. The handle stays stable; a finished task does not dispose the worker.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"task":{"type":"string","minLength":1},"project_path":{"type":"string"},"idempotency_key":{"type":"string"},"context_policy":{"type":"string","enum":["fresh","packet","parent_summary","resume","selected_history"]},"context_mode":{"type":"string","enum":["fresh","packet","parent_summary","resume","selected_history"],"description":"Advanced: alias for context_policy."},"selected_history":{"type":"array","items":{"type":"string"}},"structured_result":{"type":"boolean","default":true,"description":"Advanced: false skips the potato-result JSON block."},"acceptance_criteria":{"type":"array","items":{"type":"string","minLength":1},"description":"Advanced: free-text guidance, not machine-checked; use checks for verified acceptance."},"checks":{"type":"array","maxItems":20,"description":"Acceptance checks run at completion; a failing one fails the run with ACCEPTANCE_FAILED. command_exits runs argv (no shell) in project_path; paths are relative to it.","items":{"type":"object","properties":{"type":{"type":"string","enum":["file_exists","file_contains","file_absent","result_contains","command_exits"]},"path":{"type":"string","minLength":1,"description":"Required for file_* checks."},"text":{"type":"string","minLength":1},"command":{"type":"array","items":{"type":"string"},"minItems":1,"description":"command_exits: argv, e.g. [\"python\",\"-m\",\"pytest\",\"-q\"]."},"expect_exit":{"type":"integer","description":"command_exits: expected exit code (default 0)."},"timeout_ms":{"type":"integer","minimum":1,"maximum":600000,"description":"command_exits: default 120000."}},"required":["type"]}},"wait_ms":{"type":"integer","minimum":0,"maximum":3600000,"default":120000,"description":"How long this call waits for the turn to end. Above 300000 it keeps waiting inside the call; if still running at the end you get a handle and watch_command."},"background":{"type":"boolean","default":false},"locks":{"type":"array","items":{"type":"string","minLength":1},"description":"Advanced: resource locks (type:name) held for the run; RESOURCE_LOCKED if taken."},"model":{"type":"string"},"reasoning":{"type":"string"},"shell":{"type":"string","enum":["bash","powershell","cmd"],"description":"Advanced: shell the printed watch_command targets."}}), vec!["handle","task"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/followup",
        },
        ToolDefinition {
            name: "send_agent",
            description: "Alias of followup_task (same route, same behaviour: starts the next turn; it does NOT steer the current turn, that is send_message). Unlisted by default; prefer followup_task.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"task":{"type":"string","minLength":1},"message":{"type":"string","minLength":1},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/followup",
        },
        ToolDefinition {
            name: "answer_prompt",
            description: "Answer the approval prompt blocking a worker. Pass handle (agent run) or pane_id (pane this connection controls). Get prompt_id from wait_agents or inspect_agent. With handle, project_path is optional: the handle's own project is used (a project_path that is a different project is rejected with PROJECT_MISMATCH, a handle present in several projects with AMBIGUOUS_HANDLE; both before any key is sent). Every refusal (stale prompt_id, foreign owner, broad choice without allow_broad) also happens before input is sent. The reply carries answer.applied=true once the key is delivered; answer.warning means only the run-state bookkeeping failed, so do not answer again. Retrying the same prompt_id and choice after it was applied returns the prior receipt with answer.already_applied=true and presses nothing.",
            input_schema: json!({
                "type":"object",
                "properties":{
                    "handle":{"type":"string"},
                    "pane_id":{"type":"string"},
                    "project_path":{"type":"string"},
                    "prompt_id":{"type":"string"},
                    "choice":{"type":"string"},
                    "allow_broad":{"type":"boolean","default":false}
                },
                "required":["prompt_id","choice"],
                "anyOf":[{"required":["handle"]},{"required":["pane_id"]}]
            }),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/answer",
        },
        ToolDefinition {
            name: "cancel_agent",
            description: "Alias of interrupt_agent (same route, same behaviour). Unlisted by default; prefer interrupt_agent. Stops the current turn and keeps the worker handle.",
            input_schema: object_schema(json!({"handle":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/cancel",
        },
        ToolDefinition {
            name: "interrupt_agent",
            description: "Stop the current turn without disposing the worker. The handle stays valid for followup_task. Resolves the worker by handle even when project_path is omitted.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/cancel",
        },
        ToolDefinition {
            name: "list_agents",
            description: "List workers this connection can adopt: managed runs and live UI panes. Each entry has worker_id, backend, workspace, status, model when known, grant_required, and read_only_supported. Pass worker_id to run_agent to adopt. Alias: list_workers.",
            input_schema: object_schema(json!({"project_path":{"type":"string"},"mine_only":{"type":"boolean","default":false,"description":"Only runs and panes this connection controls."},"active_only":{"type":"boolean","default":false,"description":"Hide runs that have ended (completed/failed/cancelled)."},"ended_within_ms":{"type":"integer","minimum":0,"description":"Hide ended runs that finished longer ago than this. Runs are never deleted; this only narrows the listing."}}), vec![]),
            output_schema: Some(json!({"type":"object","properties":{"workers":{"type":"array","items":{"type":"object","properties":{"worker_id":{"type":"string"},"handle":{"type":"string"},"pane_id":{"type":["string","null"]},"backend":{"type":"string"},"workspace":{"type":"string"},"status":{"type":"string"},"model":{"type":["string","null"]},"owned":{"type":"boolean"},"grant_required":{"type":"boolean"},"read_only_supported":{"type":"boolean"},"adoptable":{"type":"boolean"}}}},"agent_types":{"type":"array","description":"What each dispatchable agent type supports: headless_supported (it has a headless mode), headless_verified (a custom agent whose headless definition the wizard tested; false for built-ins, which keep their own headless support) and run_mode (visible | one_task, the person's Settings > Agents choice that run_agent uses when headless is not passed).","items":{"type":"object","properties":{"id":{"type":"string"},"headless_supported":{"type":"boolean"},"headless_verified":{"type":"boolean"},"run_mode":{"type":"string","enum":["visible","one_task"]}}}}},"required":["workers"]})),
            safety: ToolSafety::ReadOnly, visibility: visible_everywhere(), method: "GET", path: "/agents",
        },
        ToolDefinition {
            name: "list_workers",
            description: "Alias of list_agents (same route, same behaviour). Unlisted by default; prefer list_agents.",
            input_schema: object_schema(json!({"project_path":{"type":"string"},"mine_only":{"type":"boolean","default":false},"active_only":{"type":"boolean","default":false},"ended_within_ms":{"type":"integer","minimum":0}}), vec![]),
            output_schema: Some(json!({"type":"object","properties":{"workers":{"type":"array"}},"required":["workers"]})),
            safety: ToolSafety::ReadOnly, visibility: visible_everywhere(), method: "GET", path: "/agents",
        },
        ToolDefinition {
            name: "inspect_agent",
            description: "Inspect a worker: status, current task, context_policy, requested vs resolved model, capabilities, and turn ids. Pass the handle from run_agent, not a pane id.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(), method: "GET", path: "/agents/{handle}",
        },
        ToolDefinition {
            name: "agent_transcript",
            description: "Read typed transcript events for a worker (user task/steering, assistant commentary and final response, tool activity, prompts, interruption, failure). Truncation never drops the stored turn result — use wait_agents or inspect_agent for that.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"project_path":{"type":"string"},"after":{"type":"integer","minimum":0},"operation_id":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::ReadOnly,
            visibility: visible_everywhere(), method: "GET", path: "/agents/{handle}/transcript",
        },
        ToolDefinition {
            name: "close_agent",
            description: "Explicitly end a worker session. Cancels the current turn, releases this connection's control, and returns status=closed.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(agent_run_schema()), safety: ToolSafety::Destructive,
            visibility: visible_everywhere(), method: "POST", path: "/agents/close",
        },
        ToolDefinition {
            name: "review_worktree",
            description: "Review the git worktree of a run started with run_agent(isolation=\"worktree\"). action=diff (default): changed files with +/- counts and a capped unified patch (pass path to narrow it). action=merge: --no-ff merge of the worker's branch into the project's current branch, then removes the worktree; refuses with ORIGIN_DIRTY_OVERLAP if the project has uncommitted edits to the same files, RUN_ACTIVE while the worker is still working, and on MERGE_CONFLICT aborts so the project is unchanged and lists the conflicted files. action=discard: deletes the worktree and branch (unmerged work is lost). Only for handles this connection owns.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"action":{"type":"string","enum":["diff","merge","discard"],"default":"diff"},"path":{"type":"string","description":"diff only: narrow the patch to one file."},"project_path":{"type":"string"}}), vec!["handle"]),
            output_schema: None,
            safety: ToolSafety::Destructive,
            visibility: visible_everywhere(), method: "POST", path: "/worktrees/review",
        },
        ToolDefinition {
            name: "take_over",
            description: "Take temporary pane or worker control and return the rendered screen. Pass `handle` (run handle or a list_agents worker_id/pane id) or `pane_id`. A pane not created by this connection requires grant=true. Prefer run_agent(worker_id) to adopt. This does not transfer ownership; use transfer_agent for that.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"project_path":{"type":"string"},"pane_id":{"type":"string"},"grant":{"type":"boolean","default":false}}), vec![]),
            output_schema: Some(json!({"type":"object","properties":{"handle":{"type":"string"},"pane_id":{"type":"string"},"screen":{"type":"string"},"prompt":{},"control":{"type":"string","enum":["agent","shell"]}},"required":["handle","pane_id","screen","control"]})),
            safety: ToolSafety::Mutating, visibility: visible_everywhere(), method: "POST", path: "/agents/take-over",
        },
        ToolDefinition {
            name: "shell_exec",
            description: "Run a shell command in the selected project directory.",
            input_schema: object_schema(json!({"command":{"type":"string","minLength":1},"cwd":{"type":"string"},"pane_id":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1}}), vec!["command"]),
            output_schema: Some(json!({"type":"object","properties":{"stdout":{"type":"string"},"stderr":{"type":"string"},"exit_code":{"type":"integer"}}})),
            safety: ToolSafety::Mutating, visibility: visible_everywhere(), method: "POST", path: "/shell/exec",
        },
        ToolDefinition {
            name: "release",
            description: "Return temporary manual pane control to the worker's owner. Does not drop the worker lease and does not transfer ownership. Use release_lease to drop the lease, or transfer_agent to move it.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"pane_id":{"type":"string"}}), vec![]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/release",
        },
        ToolDefinition {
            name: "session_identity",
            description: "Read this connection's coordinator identity. The connection UUID is a transport id; coordinator_id plus attach_token are the reconnect credentials. A caller-supplied name is not an identity.",
            input_schema: object_schema(json!({}), vec![]),
            output_schema: Some(json!({"type":"object","properties":{"connection_id":{"type":"string"},"coordinator_id":{"type":"string"},"attach_token":{"type":"string"}},"required":["connection_id","coordinator_id","attach_token"]})),
            safety: ToolSafety::ReadOnly, visibility: visible_everywhere(), method: "GET", path: "/mcp/session",
        },
        ToolDefinition {
            name: "attach_agents",
            description: "Re-attach this connection to a coordinator's workers after reconnect. Requires the server-issued attach_token from session_identity. coordinator_name is ignored and never grants authority.",
            input_schema: object_schema(json!({"attach_token":{"type":"string"},"coordinator_name":{"type":"string"}}), vec!["attach_token"]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/attach",
        },
        ToolDefinition {
            name: "release_lease",
            description: "Drop this connection's worker control lease. Distinct from release (return pane control) and transfer_agent (move ownership).",
            input_schema: object_schema(json!({"handle":{"type":"string"}}), vec!["handle"]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/release-lease",
        },
        ToolDefinition {
            name: "transfer_agent",
            description: "Transfer worker ownership to another live MCP connection (to_session_id). A coordinator name does not grant authority and is not a valid target.",
            input_schema: object_schema(json!({"handle":{"type":"string"},"to_session_id":{"type":"string"},"coordinator_name":{"type":"string"}}), vec!["handle","to_session_id"]),
            output_schema: Some(json!({"type":"object"})), safety: ToolSafety::Mutating,
            visibility: visible_everywhere(), method: "POST", path: "/agents/transfer",
        },
    ]
}
