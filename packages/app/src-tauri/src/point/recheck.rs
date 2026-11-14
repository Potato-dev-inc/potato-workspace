//! "Check it again" (N5-21): after a chat agent's turn ends, the preview is reloaded and the person is offered a
//! before and after strip of the element they pointed at.
//!
//! This file holds the pure parts: what is waiting, how the box sees it (`RecheckView`), the wait for the end of a
//! turn (against a small host trait, so it is tested without a chat), and the page script that finds the element
//! again. The windows live in `recheck_live.rs`.

use super::{Rect, Viewport};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// What the box shows for a recheck (a part of `PointState`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecheckView {
    /// The agent's name and task, as the "To:" list shows it.
    pub agent: String,
    /// "button.card-cta".
    pub label: String,
    /// `data:image/png;base64,...` of the element before the change. None when there was no screenshot.
    pub before: Option<String>,
    /// The element after the reload. None while the page loads or when it could not be shot.
    pub after: Option<String>,
    /// One plain sentence when something did not work.
    pub note: Option<String>,
    /// The recheck is running now (the buttons wait).
    pub busy: bool,
}

/// What a recheck needs to run again. Kept until the person dismisses it or sends another message.
#[derive(Debug, Clone)]
pub struct Pending {
    pub preview_id: String,
    pub agent: String,
    pub label: String,
    pub selector: String,
    /// The folder the after picture is saved in (the dev server's project).
    pub project: PathBuf,
    /// The picture from before the change (a file in the project's shots folder).
    pub before: Option<PathBuf>,
}

#[derive(Default)]
struct Slot {
    pending: Option<Pending>,
    view: Option<RecheckView>,
    /// Bumped by every new send, so an older wait that is still running knows it was replaced.
    generation: u64,
}

static SLOT: Lazy<Mutex<Slot>> = Lazy::new(|| Mutex::new(Slot::default()));

/// A new send starts a new recheck and drops the old one. Returns the generation the wait must still match.
pub fn begin(pending: Pending) -> u64 {
    let mut slot = SLOT.lock();
    slot.generation += 1;
    slot.view = None;
    slot.pending = Some(pending);
    slot.generation
}

pub fn is_current(generation: u64) -> bool {
    SLOT.lock().generation == generation
}

pub fn pending() -> Option<Pending> {
    SLOT.lock().pending.clone()
}

pub fn set_view(view: Option<RecheckView>) {
    SLOT.lock().view = view;
}

pub fn view() -> Option<RecheckView> {
    SLOT.lock().view.clone()
}

/// The person closed the strip, or the preview went away.
pub fn clear() {
    let mut slot = SLOT.lock();
    slot.generation += 1;
    slot.pending = None;
    slot.view = None;
}

// ---------------------------------------------------------------- waiting for the end of a turn

/// How the sent message stands in the outbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Still queued or being sent.
    Waiting,
    /// The agent has it.
    Delivered,
    /// The outbox gave up, or the message is gone.
    Lost,
}

/// What the wait needs to look at. The live one reads the outbox and the chat session.
pub trait TurnHost {
    fn delivery(&self) -> Delivery;
    /// `Some(true)` while the chat works on a turn, `Some(false)` when it is free, `None` when the chat is closed.
    fn busy(&self) -> Option<bool>;
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub every: Duration,
    /// After delivery, how many looks to wait for the turn to start before taking it as already over.
    pub start_grace: u32,
    /// Free looks in a row that count as "the turn ended" (a turn can blink free between steps).
    pub settle: u32,
    /// The longest the whole wait takes, in looks.
    pub max_looks: u32,
}

impl Default for Timing {
    fn default() -> Self {
        Self { every: Duration::from_secs(1), start_grace: 8, settle: 3, max_looks: 3_600 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// The agent's turn is over: reload now.
    Ended,
    /// The message never reached the agent, the chat closed or the recheck was replaced. Nothing to check.
    Dropped,
    /// Too long. Nothing happens by itself.
    GaveUp,
}

/// Waits until the agent's turn after this message ends. `still_wanted` says whether this recheck was replaced or
/// dismissed meanwhile.
pub fn wait_for_turn_end(host: &dyn TurnHost, t: Timing, still_wanted: &dyn Fn() -> bool) -> Wait {
    let mut delivered_looks = 0u32;
    let mut seen_busy = false;
    let mut free_in_a_row = 0u32;
    for look in 0..t.max_looks {
        if look > 0 {
            std::thread::sleep(t.every);
        }
        if !still_wanted() {
            return Wait::Dropped;
        }
        // A delivered message may leave the outbox list later (finished ones are pruned): that is not a loss.
        let seen = host.delivery();
        match seen {
            Delivery::Lost if delivered_looks == 0 => return Wait::Dropped,
            Delivery::Waiting => continue,
            Delivery::Lost | Delivery::Delivered => {}
        }
        delivered_looks += 1;
        match host.busy() {
            None => return Wait::Dropped,
            Some(true) => {
                seen_busy = true;
                free_in_a_row = 0;
            }
            Some(false) => {
                free_in_a_row += 1;
                if seen_busy && free_in_a_row >= t.settle {
                    return Wait::Ended;
                }
                // The turn never showed as busy: it was too quick to see, or steered into a running turn.
                if !seen_busy && delivered_looks >= t.start_grace {
                    return Wait::Ended;
                }
            }
        }
    }
    Wait::GaveUp
}

// ---------------------------------------------------------------- finding the element again

/// The page script that finds the picked element again and answers a JSON string with its rectangle and the
/// viewport, or null when the page is still loading or the element is gone. The selector is passed as a JSON string.
pub fn locate_script(selector: &str) -> String {
    let sel = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{try{{if(document.readyState!=='complete')return null;var e=document.querySelector({sel});if(!e)return null;\
         var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return null;\
         return JSON.stringify({{rect:{{x:r.left,y:r.top,w:r.width,h:r.height}},viewport:{{w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio||1}}}})}}catch(x){{return null}}}})()"
    )
}

#[derive(Deserialize)]
struct Located {
    rect: Rect,
    viewport: Viewport,
}

/// The rectangle and viewport from the locate script's text (`window::parse_take` already unwrapped the string).
pub fn parse_located(text: &str) -> Option<(Rect, Viewport)> {
    let l: Located = serde_json::from_str(text).ok()?;
    let size = |v: f64| v.is_finite() && v > 0.0 && v <= 16_384.0;
    let ok = size(l.rect.w)
        && size(l.rect.h)
        && size(l.viewport.w)
        && size(l.viewport.h)
        && l.rect.x.is_finite()
        && l.rect.y.is_finite()
        && l.viewport.dpr.is_finite()
        && l.viewport.dpr > 0.0;
    ok.then_some((l.rect, l.viewport))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Each call to `delivery` and `busy` reads the next entry (the last one repeats).
    struct Script {
        d: AtomicUsize,
        b: AtomicUsize,
        delivery: Vec<Delivery>,
        busy: Vec<Option<bool>>,
    }

    impl Script {
        fn new(delivery: Vec<Delivery>, busy: Vec<Option<bool>>) -> Self {
            Script { d: AtomicUsize::new(0), b: AtomicUsize::new(0), delivery, busy }
        }
    }

    impl TurnHost for Script {
        fn delivery(&self) -> Delivery {
            let n = self.d.fetch_add(1, Ordering::SeqCst);
            *self.delivery.get(n).or(self.delivery.last()).unwrap()
        }
        fn busy(&self) -> Option<bool> {
            let n = self.b.fetch_add(1, Ordering::SeqCst);
            *self.busy.get(n).or(self.busy.last()).unwrap()
        }
    }

    fn fast() -> Timing {
        Timing { every: Duration::from_millis(1), start_grace: 3, settle: 2, max_looks: 40 }
    }

    fn run(delivery: Vec<Delivery>, busy: Vec<Option<bool>>) -> (Wait, usize) {
        let host = Script::new(delivery, busy);
        let out = wait_for_turn_end(&host, fast(), &|| true);
        (out, host.b.load(Ordering::SeqCst))
    }

    #[test]
    fn it_waits_for_the_turn_to_start_and_end_then_reloads() {
        let (t, f) = (Some(true), Some(false));
        assert_eq!(run(vec![Delivery::Delivered], vec![t, t, t, t, f, f]), (Wait::Ended, 6));
    }

    #[test]
    fn a_blink_of_free_between_steps_does_not_end_the_turn() {
        let (t, f) = (Some(true), Some(false));
        // One free look, busy again, then two free looks in a row.
        assert_eq!(run(vec![Delivery::Delivered], vec![t, f, t, t, f, f]), (Wait::Ended, 6));
    }

    #[test]
    fn a_message_still_queued_is_not_a_finished_turn() {
        // The agent is free all the time, but the message has not gone in: the busy look is never asked.
        let w = Delivery::Waiting;
        assert_eq!(run(vec![w], vec![Some(false)]), (Wait::GaveUp, 0));
        // Once it goes in (after 3 looks) the turn is judged from then on.
        let d = Delivery::Delivered;
        let (out, asked) = run(vec![w, w, w, d], vec![Some(true), Some(false), Some(false)]);
        assert_eq!((out, asked), (Wait::Ended, 3));
    }

    #[test]
    fn a_turn_too_quick_to_see_ends_after_the_grace() {
        assert_eq!(run(vec![Delivery::Delivered], vec![Some(false)]), (Wait::Ended, 3));
    }

    #[test]
    fn a_lost_message_or_a_closed_chat_checks_nothing() {
        assert_eq!(run(vec![Delivery::Lost], vec![Some(false)]).0, Wait::Dropped);
        assert_eq!(run(vec![Delivery::Delivered], vec![None]).0, Wait::Dropped);
    }

    #[test]
    fn a_delivered_message_that_leaves_the_outbox_list_is_not_a_loss() {
        let (d, l) = (Delivery::Delivered, Delivery::Lost);
        let (t, f) = (Some(true), Some(false));
        assert_eq!(run(vec![d, l, l, l, l], vec![t, t, t, f, f]), (Wait::Ended, 5));
    }

    #[test]
    fn a_replaced_recheck_stops_waiting() {
        let host = Script::new(vec![Delivery::Delivered], vec![Some(true)]);
        assert_eq!(wait_for_turn_end(&host, fast(), &|| false), Wait::Dropped);
    }

    #[test]
    fn a_new_send_replaces_the_old_recheck() {
        let p = |id: &str| Pending { preview_id: id.into(), agent: "A".into(), label: "l".into(), selector: "s".into(), project: PathBuf::new(), before: None };
        let first = begin(p("preview-1"));
        let second = begin(p("preview-2"));
        assert!(!is_current(first));
        assert!(is_current(second));
        assert_eq!(pending().unwrap().preview_id, "preview-2");
        clear();
        assert!(pending().is_none() && view().is_none());
    }

    #[test]
    fn the_locate_script_carries_the_selector_as_a_json_string() {
        let js = locate_script("button[data-testid=\"a\"]; alert(1)//");
        assert!(js.contains(r#"document.querySelector("button[data-testid=\"a\"]; alert(1)//")"#), "{js}");
    }

    #[test]
    fn a_located_rect_must_be_sane() {
        let good = r#"{"rect":{"x":10,"y":20,"w":100,"h":40},"viewport":{"w":800,"h":600,"dpr":1.5}}"#;
        assert!(parse_located(good).is_some());
        let flat = r#"{"rect":{"x":10,"y":20,"w":0,"h":40},"viewport":{"w":800,"h":600,"dpr":1}}"#;
        assert!(parse_located(flat).is_none());
        let huge = r#"{"rect":{"x":0,"y":0,"w":10,"h":10},"viewport":{"w":99999,"h":600,"dpr":1}}"#;
        assert!(parse_located(huge).is_none());
        assert!(parse_located("not json").is_none());
    }
}
