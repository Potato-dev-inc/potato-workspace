//! What the PC link's routes need from the app. The real one (`app_services.rs`) reaches the pane registry, the chat reader,
//! the message outbox and the project list; tests bring a fake. Every method answers `(status, json)`, already in the PC
//! link's own shapes. None of them checks a right: `pclink::handle` did that before calling.

use serde_json::Value;

use super::{Ask, Level};

/// One event payload's form for a PC (`events::view`).
pub type EventView<'v> = dyn for<'a> Fn(&'a str) -> Option<std::borrow::Cow<'a, str>> + Sync + 'v;

pub trait Services: Send + Sync {
    /// This PC's name, for "Runs on <name>".
    fn name(&self) -> String;

    /// The most a PC may do in one session: `None` when the person marked it "not for remote use" on this PC, otherwise a level
    /// (a session with no rule of its own allows `Full`: the rule only takes rights away).
    fn ceiling(&self, session: &str) -> Option<Level>;

    // ----- Watch -----
    /// `{ sessions: [{ id, agent, title, status, project, folder, chat, branch, model, mode, parent? }` (`branch`/`model`: sanitized names or null, `mode`: asks | acts_without_asking | unknown, see `meta.rs`; `project`: the folder's opaque id; `folder`: its name; no path)] }`.
    fn sessions(&self) -> (u16, Value);
    /// The newest items of a session's transcript, or what changed since revision `since`.
    fn transcript(&self, session: &str, since: Option<u64>) -> (u16, Value);
    fn transcript_earlier(&self, session: &str, before: &str, limit: Option<usize>) -> (u16, Value);
    fn picture(&self, session: &str, path: &str) -> (u16, Value);
    /// `{ projects: [{ id, name, state }] }`: folders this PC knows, by opaque id (a path never travels).
    fn projects(&self) -> (u16, Value);
    /// `{ rows: [...], refreshed_at_ms }`: this PC's own usage and limits, in the shape of its own usage bar. Lent and borrowed
    /// sign-ins are left out: they are not this PC's own numbers.
    fn usage(&self) -> (u16, Value);
    /// `{ agents: [{ id, label, chat, terminal }], terminals }`.
    fn agents(&self) -> (u16, Value);
    /// `{ questions: [...] }`: the ones a PC may answer (an agent's own question or permission, never a person-only card).
    /// Below Full (`full` false) a permission card shows only its "no" choices.
    fn questions(&self, full: bool) -> (u16, Value);

    // ----- Answer -----
    fn outbox(&self, session: &str) -> (u16, Value);
    /// A message for the session's agent, from the paired PC `node`.
    /// `full`: the asker is at Full. Below Full a chat that would run the message with no card at all (a no-questions mode, or
    /// kinds of action allowed without asking) is refused: that would be Full by another name.
    fn send(&self, node: &str, session: &str, text: &str, full: bool) -> (u16, Value);
    fn cancel_message(&self, session: &str, message: &str) -> (u16, Value);
    fn interrupt(&self, session: &str) -> (u16, Value);
    /// `full`: the asker is at Full. Below Full, a tool permission can only be DENIED: approving one (it runs commands, edits files
    /// or reaches the network) is what Full means.
    fn answer_question(&self, id: &str, body: &Value, full: bool) -> (u16, Value);

    // ----- Full -----
    fn set_config(&self, node: &str, session: &str, option: &str, value: &str, hold: bool) -> (u16, Value);
    fn models(&self, agent: &str) -> (u16, Value);
    /// `GET /pclink/browse`: the places this PC lets another browse (no `root`), or the folders inside one (`root`, `sub`). No path travels.
    fn browse(&self, root: Option<&str>, sub: &str) -> (u16, Value);
    /// `POST /pclink/projects/open`: make a browsed folder one of this PC's known projects; the answer is `{ project: { id, name, state } }`.
    fn open_folder(&self, root: &str, sub: &str) -> (u16, Value);
    fn start(&self, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> (u16, Value);
    fn warm(&self, agent: &str, project: &str) -> (u16, Value);
    /// Closes one session (an agent that was started by mistake, or a move that did not finish).
    fn close(&self, node: &str, session: &str) -> (u16, Value);
    /// Whether `path` is one of the folders this PC knows (its recent and indexed projects).
    fn known_folder(&self, path: &str) -> bool;
    /// The far side of "Take the conversation and the work": a git bundle checked out in one of this PC's known projects.
    fn move_work(&self, project: &str, branch: &str, bundle_b64: &str) -> (u16, Value);

    /// `POST /pclink/call/<cmd>` (`calls.rs`): the same inner function the Tauri command `cmd` runs, with `args` (the body). The level
    /// and the pane's own rule were checked before; the press-and-hold rule (`hold: true`) is this method's to enforce. The answer is
    /// what the command returns; an error is `{ code, error }` with its status.
    fn call(&self, node: &str, cmd: &str, args: &Value) -> (u16, Value);

    /// `POST /pclink/stream/preview` (`preview.rs`): one HTTP request to a dev-server port this PC lists for a chat. Full.
    fn preview(&self, _node: &str, _request: &Value) -> (u16, Value) {
        (404, serde_json::json!({ "error": "not found", "code": "UNKNOWN_ROUTE" }))
    }

    /// A PC asked for Full: show the person on this PC a card (the app emits its window event). Never grants anything.
    fn notify_full_request(&self, ask: &Ask);

    /// The event log after `cursor`, each payload run through `view` (`events::view`), waiting up to `wait`.
    fn events(&self, cursor: Option<u64>, wait: std::time::Duration, view: &EventView<'_>) -> (u64, String);

    /// The frame `node` is sent for one event the level let through (the app meters terminal output: `terminal::throttle`).
    fn frame_for(&self, _node: &str, frame: String) -> Option<String> {
        Some(frame)
    }
}
