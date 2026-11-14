//! Tauri commands of Point and Fix (SPEC n32 section 3.5). The logic lives in `crate::point`; these are the
//! thin wrappers that the Point box, the preview chip and the Chat tab call.
//!
//! Sending goes only through the pane outbox (`send_with`). A refused message keeps the picks and shows the
//! outbox's own sentence. Point never writes to a pane itself.

use super::AppState;
use crate::app_windows;
use crate::attach::{self, ChatAttachment};
use crate::pane_outbox::{self, OutboxMessage};
use crate::point::box_window;
use crate::point::message;
use crate::point::recheck::Pending;
use crate::point::recheck_live;
use crate::point::session::{PointState, SESSION};
use crate::point::shot;
use crate::point::target::TargetFacts;
use crate::point::window::{self, PreviewInfo};
use crate::point::Pick;
use crate::pty::PaneRegistry;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// The pane is gone from the registry (closed between the list and the send).
const NO_PANE: &str = "This pane is not open any more.";
/// A screenshot that cannot be copied into the agent's folder. The message still goes, without it.
/// A screenshot that cannot be attached to a chat message. The message still goes, without it.
const ATTACH_FAILED: &str = "The screenshot could not be attached.";
const COPY_FAILED: &str = "The screenshot could not be copied into the agent's folder.";
/// A pane the "To:" list greys out, without a sentence of its own.
const NOT_A_TARGET: &str = "This pane cannot take a message now.";
/// A failed message the outbox gave no sentence for.
const FAILED: &str = "The message was not sent. Check the terminal.";

/// Opens the preview of a dev server pane's port in its own window. The frontend arms it after.
#[tauri::command(async)]
pub fn point_open_preview(
    app: AppHandle,
    _state: State<'_, AppState>,
    pane_id: String,
    port: u16,
) -> Result<PreviewInfo, String> {
    window::open(&app, &pane_id, port, false)
}

/// The Point box's state: picks, the "To:" list, the default pane and the notice.
#[tauri::command]
pub fn point_state(app: AppHandle, _state: State<'_, AppState>) -> PointState {
    window::current_state(&app)
}

/// Focuses the newest preview window and arms its picker.
#[tauri::command]
pub fn point_arm(app: AppHandle) -> Result<(), String> {
    window::arm_newest(&app)
}

/// Removes one pick (its screenshot file goes too) and returns the new state.
#[tauri::command]
pub fn point_remove_pick(app: AppHandle, _state: State<'_, AppState>, pick_id: String) -> PointState {
    window::remove_pick(&app, &pick_id)
}

/// The message text for the picks and the request, as the target pane's folder sees it. Used by Copy.
#[tauri::command]
pub fn point_compose(state: State<'_, AppState>, target_pane_id: String, request: String) -> Result<String, String> {
    let target = target_of(&state, &target_pane_id)?;
    compose_text(live_picks(), &request, Path::new(&target.cwd))
}

/// Sends the message to the target pane through the pane outbox. On success the session ends (its
/// screenshots stay, the message names them) and the preview shows a short note.
#[tauri::command]
pub async fn point_send(
    app: AppHandle,
    state: State<'_, AppState>,
    target_pane_id: String,
    request: String,
) -> Result<OutboxMessage, String> {
    let target = target_of(&state, &target_pane_id)?;
    // A pane on a dialog, a question or without its input box gets nothing typed, and nothing is closed for it.
    if let Some(why) = refusal(&target) {
        return Err(why);
    }
    let picks = live_picks();
    let preview_id = picks.last().map(|p| p.preview_id.clone()).unwrap_or_default();
    let recheck_pending = target.chat.then(|| recheck_of(&picks, &target)).flatten();
    let out = outgoing(picks, &request, &target)?;
    let note = sent_note(&target);
    let host = LiveOutbox { app: app.clone(), registry: state.registry.clone() };
    let watched = target_pane_id.clone();
    let sent = tauri::async_runtime::spawn_blocking(move || send_with(&host, &target_pane_id, &out.text, &out.attachments))
        .await
        .map_err(|e| format!("INTERNAL: {e}"))??;
    watch_for_failure(&app, state.registry.clone(), watched.clone(), sent.id.clone(), preview_id.clone(), &target);
    // A chat agent's turn ends by itself: when it does, the preview is reloaded and the strip is offered.
    if let Some(pending) = recheck_pending {
        recheck_live::start(&app, state.registry.clone(), pending, watched, sent.id.clone());
    }
    SESSION.lock().discard_keep_files();
    box_window::hide(&app);
    window::toast(&app, &preview_id, &note);
    Ok(sent)
}

/// Runs the "Check it again" strip once more: reload the preview and shoot the element again.
#[tauri::command(async)]
pub fn point_recheck_run(app: AppHandle) {
    recheck_live::run(&app);
}

/// Closes the before and after strip.
#[tauri::command]
pub fn point_recheck_dismiss(app: AppHandle) {
    recheck_live::dismiss(&app);
}

/// "Edit in Chat": keeps the composed text as that pane's draft, ends the session, and opens the pane's
/// Chat tab. The composer takes the draft (`point_take_draft`).
#[tauri::command]
pub fn point_edit_in_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    target_pane_id: String,
    request: String,
) -> Result<(), String> {
    let target = target_of(&state, &target_pane_id)?;
    let text = compose_text(live_picks(), &request, Path::new(&target.cwd))?;
    SESSION.lock().discard_keep_files();
    put_chat_draft(&app, &target_pane_id, text);
    box_window::hide(&app);
    app_windows::open_cockpit_window(&app, Some(&target_pane_id), true);
    Ok(())
}

/// Keeps `text` as the pane's pending Chat draft (the composer takes it once) and tells the windows
/// (`point://draft`). Shared by "Edit in Chat" and Review Desk's Ask to fix (SPEC n33 section 3.5 G).
/// Nothing is sent: the person reads the draft and sends it from the Chat box.
pub(crate) fn put_chat_draft(app: &AppHandle, pane_id: &str, text: String) {
    SESSION.lock().put_draft(pane_id, text);
    let _ = app.emit("point://draft", serde_json::json!({ "paneId": pane_id }));
}

/// Hands a pane its pending draft, once.
#[tauri::command]
pub fn point_take_draft(pane_id: String) -> Option<String> {
    SESSION.lock().take_draft(&pane_id)
}

/// Throws the session away: deletes its screenshots, hides the box and turns the pickers off.
#[tauri::command]
pub fn point_discard(app: AppHandle) {
    window::discard_all(&app);
}

/// Hides the Point box. The session stays.
#[tauri::command]
pub fn point_box_hide(app: AppHandle) {
    box_window::hide(&app);
}

/// Opens the last link the preview refused, in the browser. Only http and https (checked again there).
#[tauri::command]
pub fn point_open_blocked_link(_app: AppHandle) -> Result<(), String> {
    let url = SESSION.lock().blocked_url().map(str::to_string).ok_or("No blocked link to open.")?;
    crate::app_lifecycle::open_external_url(url)
}

// ---------------------------------------------------------------- helpers

/// The one way a message reaches a pane: the pane outbox.
trait SendHost: Send + Sync {
    fn send(&self, pane_id: &str, text: &str, attachments: &[ChatAttachment]) -> Result<OutboxMessage, String>;
    /// The pane's messages as the outbox lists them now (a failure shows there after the send was queued).
    fn list(&self, pane_id: &str) -> Vec<OutboxMessage>;
}

/// The live outbox (`pane_outbox::global`).
struct LiveOutbox {
    app: AppHandle,
    registry: Arc<Mutex<PaneRegistry>>,
}

impl SendHost for LiveOutbox {
    fn send(&self, pane_id: &str, text: &str, attachments: &[ChatAttachment]) -> Result<OutboxMessage, String> {
        pane_outbox::global(&self.registry, &self.app).send_with(pane_id, text, attachments)
    }

    fn list(&self, pane_id: &str) -> Vec<OutboxMessage> {
        pane_outbox::global(&self.registry, &self.app).list(pane_id)
    }
}

/// Hands the text to the pane outbox, once. Its error is returned unchanged (the person reads it under the box).
fn send_with(host: &dyn SendHost, pane_id: &str, text: &str, attachments: &[ChatAttachment]) -> Result<OutboxMessage, String> {
    host.send(pane_id, text, attachments)
}

/// What one send carries: the text and, for a chat pane, the screenshots as attachments.
struct Outgoing {
    text: String,
    attachments: Vec<ChatAttachment>,
}

/// The message for this target. A terminal agent gets one text with the screenshot path in it. A chat agent gets
/// the text and each screenshot as an image attachment (the chat attachment path, so the picture shows in the
/// message and reaches an agent that takes images). A screenshot that cannot be attached is left out with a reason.
fn outgoing(picks: Vec<Pick>, request: &str, target: &TargetFacts) -> Result<Outgoing, String> {
    let cwd = Path::new(&target.cwd);
    if !target.chat {
        return Ok(Outgoing { text: compose_text(picks, request, cwd)?, attachments: Vec::new() });
    }
    let mut attachments = Vec::new();
    let picks: Vec<Pick> = picks
        .into_iter()
        .map(|mut pick| {
            if let Some(shot) = pick.shot.clone() {
                match attach::prepare_one(&shot.abs_path, &target.cwd) {
                    Ok(one) => attachments.push(one),
                    Err(_) => {
                        pick.shot = None;
                        pick.no_shot_reason = Some(ATTACH_FAILED);
                    }
                }
            }
            pick
        })
        .collect();
    let refs: Vec<&Pick> = picks.iter().collect();
    // The chat shows the attachment under the sentence, so the text names it ("attached") instead of a path.
    let text = message::compose_with(&refs, request, cwd, message::Shots::Attached)?;
    // The names in the text are the attachments' own names, in the same order.
    Ok(Outgoing { text, attachments })
}

/// Why a message to this pane is refused before anything is queued (the "To:" list greys it out for the same reason).
fn refusal(target: &TargetFacts) -> Option<String> {
    let (can_send, why) = crate::point::target::gate(target);
    (!can_send).then(|| why.unwrap_or_else(|| NOT_A_TARGET.to_string()))
}

/// How long, and how often, Point looks at a queued message to learn that it failed.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(1);
const WATCH_ROUNDS: u32 = 1800;

/// Follows a queued message until it is sent, cancelled or gone. `Some(sentence)` when it failed: the outbox
/// keeps the failed message and its reason; this is how the person learns of it after the Point box closed.
fn failure_of(host: &dyn SendHost, pane_id: &str, message_id: &str, every: std::time::Duration, rounds: u32) -> Option<String> {
    for round in 0..rounds {
        if round > 0 {
            std::thread::sleep(every);
        }
        match host.list(pane_id).into_iter().find(|m| m.id == message_id) {
            None => return None,
            Some(m) if m.state == pane_outbox::State::Failed => return Some(m.error.unwrap_or_else(|| FAILED.to_string())),
            Some(m) if m.state.active() => {}
            Some(_) => return None,
        }
    }
    None
}

/// The note the preview shows when a queued message failed.
fn failed_note(target: &TargetFacts, why: &str) -> String {
    format!("Not sent to {} \u{b7} {}. {why}", target.agent_label, target.title)
}

fn watch_for_failure(app: &AppHandle, registry: Arc<Mutex<PaneRegistry>>, pane_id: String, message_id: String, preview_id: String, target: &TargetFacts) {
    let (app, target) = (app.clone(), target.clone());
    std::thread::spawn(move || {
        let host = LiveOutbox { app: app.clone(), registry };
        if let Some(why) = failure_of(&host, &pane_id, &message_id, WATCH_EVERY, WATCH_ROUNDS) {
            window::toast(&app, &preview_id, &failed_note(&target, &why));
        }
    });
}

/// The pane the person picked in the "To:" list, from the live registry.
fn target_of(state: &AppState, pane_id: &str) -> Result<TargetFacts, String> {
    let infos = state.registry.lock().list();
    window::target_facts(&state.registry, &infos).into_iter().find(|t| t.pane_id == pane_id).ok_or_else(|| NO_PANE.to_string())
}

/// What "Check it again" needs for the newest pick: its preview, selector and the picture from before.
/// None when there is no pick.
fn recheck_of(picks: &[Pick], target: &TargetFacts) -> Option<Pending> {
    let pick = picks.last()?;
    let before = pick.shot.as_ref().map(|s| s.abs_path.clone());
    // The shots folder is `<project>/.potato-workspace/shots/<file>`: the project is three levels up.
    let project = before.as_ref().and_then(|p| p.ancestors().nth(3)).map(Path::to_path_buf).unwrap_or_else(|| Path::new(&target.cwd).to_path_buf());
    Some(Pending {
        preview_id: pick.preview_id.clone(),
        agent: format!("{} \u{b7} {}", target.agent_label, target.title),
        label: pick.facts.label.clone(),
        selector: pick.facts.selector.clone(),
        project,
        before,
    })
}

/// The picks that wait for a request. An expired session has none (the box shows none either).
fn live_picks() -> Vec<Pick> {
    let session = SESSION.lock();
    if session.is_expired(now_ms()) {
        Vec::new()
    } else {
        session.picks().to_vec()
    }
}

/// The picks with their screenshots copied into the agent's folder, so the path in the message is one the
/// agent can open. A screenshot that cannot be copied is dropped with a reason; the message still goes.
fn picks_for_folder(picks: Vec<Pick>, cwd: &Path) -> Vec<Pick> {
    picks
        .into_iter()
        .map(|mut pick| {
            if let Some(shot) = pick.shot.clone() {
                match shot::copy_into(&shot, cwd) {
                    Ok(copied) => pick.shot = Some(copied),
                    Err(_) => {
                        pick.shot = None;
                        pick.no_shot_reason = Some(COPY_FAILED);
                    }
                }
            }
            pick
        })
        .collect()
}

/// The message text for these picks and this request, for the agent in `cwd`.
fn compose_text(picks: Vec<Pick>, request: &str, cwd: &Path) -> Result<String, String> {
    let picks = picks_for_folder(picks, cwd);
    let refs: Vec<&Pick> = picks.iter().collect();
    message::compose(&refs, request, cwd)
}

/// The short note the preview shows after a send.
fn sent_note(target: &TargetFacts) -> String {
    format!("Sent to {} \u{b7} {}. It waits until the agent is free.", target.agent_label, target.title)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::point::{PickFacts, Rect, Shot, Viewport};
    use std::path::PathBuf;

    /// Records every call. Point must make exactly one, and only to the outbox.
    #[derive(Default)]
    struct FakeOutbox {
        calls: std::sync::Mutex<Vec<(String, String)>>,
        attached: std::sync::Mutex<Vec<Vec<ChatAttachment>>>,
        answer: Option<String>,
    /// What the outbox lists for the pane, one entry per later look (the last repeats).
    listed: std::sync::Mutex<Vec<Vec<OutboxMessage>>>,
    }

    impl SendHost for FakeOutbox {
        fn send(&self, pane_id: &str, text: &str, attachments: &[ChatAttachment]) -> Result<OutboxMessage, String> {
            self.calls.lock().unwrap().push((pane_id.to_string(), text.to_string()));
            self.attached.lock().unwrap().push(attachments.to_vec());
            match &self.answer {
                Some(refusal) => Err(refusal.clone()),
                None => Ok(OutboxMessage {
                    id: "m1".into(),
                    text: text.into(),
                    created_at: 0,
                    state: crate::pane_outbox::State::Queued,
                    waiting_for: None,
                    error: None,
                    no_answer: false,
                    attachments: Vec::new(),
                }),
            }
        }

        fn list(&self, _pane_id: &str) -> Vec<OutboxMessage> {
            let mut listed = self.listed.lock().unwrap();
            if listed.len() > 1 { listed.remove(0) } else { listed.first().cloned().unwrap_or_default() }
        }
    }

    fn pick(shot: Option<Shot>) -> Pick {
        Pick {
            id: "p1".into(),
            preview_id: "preview-1".into(),
            facts: PickFacts {
                page: "localhost:5173/pricing".into(),
                url: "http://localhost:5173/pricing".into(),
                title: "Pricing".into(),
                tag: "button".into(),
                label: "button.card-cta".into(),
                selector: "button.card-cta".into(),
                text: "Get started".into(),
                html: "<button>".into(),
                rect: Rect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 },
                viewport: Viewport { w: 800.0, h: 600.0, dpr: 1.0 },
                attrs: vec![],
                styles: vec![],
                component: None,
                source_hint: None,
            },
            source: None,
            shot,
            no_shot_reason: None,
            created_ms: 0,
        }
    }

    #[test]
    fn send_makes_one_outbox_call_with_the_target_and_text() {
        let host = FakeOutbox::default();
        let sent = send_with(&host, "pane-7", "make it green", &[]).expect("the outbox accepts");
        assert_eq!(sent.text, "make it green");
        let calls = host.calls.lock().unwrap().clone();
        assert_eq!(calls, vec![("pane-7".to_string(), "make it green".to_string())]);
    }

    #[test]
    fn a_refused_send_gives_the_outbox_sentence_back_unchanged() {
        let host = FakeOutbox { answer: Some("The agent is working. Sends when the turn ends.".into()), ..Default::default() };
        let err = send_with(&host, "pane-7", "make it green", &[]).unwrap_err();
        assert_eq!(err, "The agent is working. Sends when the turn ends.");
        assert_eq!(host.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_picks_or_no_request_give_the_plain_sentences() {
        let cwd = Path::new("C:/project");
        assert_eq!(compose_text(vec![], "make it green", cwd).unwrap_err(), "Point at something first.");
        assert_eq!(compose_text(vec![pick(None)], "  ", cwd).unwrap_err(), "Write what should change.");
    }

    #[test]
    fn a_screenshot_that_cannot_be_copied_is_dropped_with_a_reason() {
        // The source file does not exist, so the copy fails; the pick stays, without its shot.
        let missing = Shot {
            abs_path: PathBuf::from("point-pf13-missing/pick-20261028-000000-1.png"),
            rel_path: ".potato-workspace/shots/pick-20261028-000000-1.png".into(),
            width: 10,
            height: 10,
        };
        let agent = std::env::temp_dir().join(format!("pm-pf13-agent-{}", uuid::Uuid::new_v4().simple()));
        let out = picks_for_folder(vec![pick(Some(missing))], &agent);
        assert!(out[0].shot.is_none());
        assert_eq!(out[0].no_shot_reason, Some(COPY_FAILED));
    }

    /// A real PNG-named file in a temp project, standing in for the picker's saved crop.
    fn shot_file(root: &Path) -> Shot {
        let dir = root.join(".potato-workspace").join("shots");
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("pick-20261115-000000-1.png");
        std::fs::write(&abs, [0x89, b'P', b'N', b'G']).unwrap();
        Shot { abs_path: abs, rel_path: ".potato-workspace/shots/pick-20261115-000000-1.png".into(), width: 10, height: 10 }
    }

    fn temp_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pm-n521-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_message_to_a_chat_pane_carries_the_screenshot_as_an_image_attachment() {
        let project = temp_project("chat");
        let mut chat = target(None);
        chat.chat = true;
        chat.cwd = project.display().to_string();
        let out = outgoing(vec![pick(Some(shot_file(&project)))], "make it green", &chat).expect("composes");
        assert_eq!(out.attachments.len(), 1);
        let one = &out.attachments[0];
        assert_eq!(one.kind, attach::AttachKind::Image);
        assert_eq!(one.mime.as_deref(), Some("image/png"));
        assert!(Path::new(&one.path).is_file(), "the attachment file exists");
        assert!(one.path.replace("\\", "/").contains("/.potato-workspace/attachments/"), "{}", one.path);
        // The text says the picture is attached and carries no path to open.
        assert!(out.text.contains("- Screenshot: attached to this message (pick-20261115-000000-1.png)"), "{}", out.text);
        assert!(!out.text.contains("open this image file"), "{}", out.text);
        // And it goes through the outbox in one call, with the attachment.
        let host = FakeOutbox::default();
        send_with(&host, "pane-7", &out.text, &out.attachments).unwrap();
        assert_eq!(host.attached.lock().unwrap()[0].len(), 1);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_message_to_a_terminal_pane_keeps_the_path_and_has_no_attachment() {
        let project = temp_project("term");
        let mut term = target(None);
        term.cwd = project.display().to_string();
        let out = outgoing(vec![pick(Some(shot_file(&project)))], "make it green", &term).expect("composes");
        assert!(out.attachments.is_empty());
        assert!(out.text.contains("open this image file"), "{}", out.text);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_screenshot_that_cannot_be_attached_leaves_the_message_going_without_it() {
        let project = temp_project("gone");
        let mut chat = target(None);
        chat.chat = true;
        chat.cwd = project.display().to_string();
        let missing = Shot { abs_path: project.join("nope.png"), rel_path: ".potato-workspace/shots/nope.png".into(), width: 1, height: 1 };
        let out = outgoing(vec![pick(Some(missing))], "make it green", &chat).expect("still composes");
        assert!(out.attachments.is_empty());
        assert!(out.text.contains("Screenshot: none (the screenshot could not be attached)"), "{}", out.text);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn the_sent_note_names_the_agent_and_the_pane() {
        let target = TargetFacts {
            pane_id: "pane-7".into(),
            agent_label: "Codex".into(),
            title: "fix-pricing".into(),
            cwd: "C:/project".into(),
            kind: crate::pane_outbox::PaneKind::Agent,
            run_controls: false,
            chat: false,
            not_ready: None,
            last_output_at: None,
        };
        assert_eq!(sent_note(&target), "Sent to Codex \u{b7} fix-pricing. It waits until the agent is free.");
    }
    fn message(state: crate::pane_outbox::State, error: Option<&str>) -> OutboxMessage {
        OutboxMessage { id: "m1".into(), text: "x".into(), created_at: 0, state, waiting_for: None, error: error.map(str::to_string), no_answer: false, attachments: Vec::new() }
    }

    fn target(not_ready: Option<&str>) -> TargetFacts {
        TargetFacts {
            pane_id: "pane-7".into(),
            agent_label: "Codex".into(),
            title: "fix-pricing".into(),
            cwd: "C:/project".into(),
            kind: crate::pane_outbox::PaneKind::Agent,
            run_controls: false,
            chat: false,
            not_ready: not_ready.map(str::to_string),
            last_output_at: None,
        }
    }

    #[test]
    fn a_pane_on_a_dialog_is_refused_before_anything_is_queued() {
        assert_eq!(refusal(&target(None)), None);
        let why = "The agent asks something. Answer it first.";
        assert_eq!(refusal(&target(Some(why))).as_deref(), Some(why));
        let mut protocol = target(None);
        protocol.kind = crate::pane_outbox::PaneKind::Protocol;
        assert!(refusal(&protocol).is_some());
    }

    #[test]
    fn a_message_that_fails_after_it_was_queued_is_reported_with_the_outbox_sentence() {
        use crate::pane_outbox::State;
        let host = FakeOutbox::default();
        *host.listed.lock().unwrap() = vec![
            vec![message(State::Queued, None)],
            vec![message(State::Sending, None)],
            vec![message(State::Failed, Some("The message is in the terminal box but was not sent. Press Enter there, or clear it."))],
        ];
        let every = std::time::Duration::from_millis(1);
        let why = failure_of(&host, "pane-7", "m1", every, 10).expect("the failure is seen");
        assert!(why.starts_with("The message is in the terminal box"), "{why}");
        assert_eq!(
            failed_note(&target(None), &why),
            "Not sent to Codex \u{b7} fix-pricing. The message is in the terminal box but was not sent. Press Enter there, or clear it."
        );
    }

    #[test]
    fn a_message_that_was_sent_or_left_the_list_raises_no_failure() {
        use crate::pane_outbox::State;
        let every = std::time::Duration::from_millis(1);
        let sent = FakeOutbox::default();
        *sent.listed.lock().unwrap() = vec![vec![message(State::Queued, None)], vec![message(State::Sent, None)]];
        assert_eq!(failure_of(&sent, "p", "m1", every, 10), None);
        let gone = FakeOutbox::default();
        assert_eq!(failure_of(&gone, "p", "m1", every, 10), None);
        // Still waiting when the watch ends: not a failure either.
        let waiting = FakeOutbox::default();
        *waiting.listed.lock().unwrap() = vec![vec![message(State::Queued, None)]];
        assert_eq!(failure_of(&waiting, "p", "m1", every, 3), None);
    }
}
