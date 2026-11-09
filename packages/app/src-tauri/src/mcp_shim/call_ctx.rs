//! Per-call context that lives in thread-locals: whether the caller cancelled this call, and where
//! `notifications/progress` for it go. A call may run on a helper thread (see `call.rs`), which
//! copies this context, so deep code (the restart wait in `bridge_http`) can stay free of plumbing.

use super::*;
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::Sender;
use std::sync::Arc;

/// Where one call's progress notifications go. Cheap to clone; clones share one counter so the
/// `progress` value keeps rising across threads (MCP requires it to).
#[derive(Clone)]
pub(crate) struct ProgressSink {
    token: Value,
    sender: Sender<String>,
    counter: Arc<AtomicU64>,
}

impl ProgressSink {
    pub(crate) fn new(token: Value, sender: Sender<String>) -> Self {
        Self { token, sender, counter: Arc::new(AtomicU64::new(0)) }
    }

    /// `Some` only when the caller sent a progress token and a notification channel exists.
    pub(crate) fn from_parts(token: Option<Value>, sender: Option<Sender<String>>) -> Option<Self> {
        Some(Self::new(token.filter(|t| !t.is_null())?, sender?))
    }

    pub(crate) fn send(&self, message: &str) {
        let progress = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.sender.send(
            json!({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": { "progressToken": self.token, "progress": progress, "message": message }
            })
            .to_string(),
        );
    }
}

thread_local! {
    static SINK: RefCell<Option<ProgressSink>> = const { RefCell::new(None) };
    static CANCELLED: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

/// What a helper thread needs to continue a call.
#[derive(Clone, Default)]
pub(crate) struct CallContext {
    pub(crate) sink: Option<ProgressSink>,
    pub(crate) cancelled: Option<Arc<AtomicBool>>,
}

pub(crate) fn current_call_context() -> CallContext {
    CallContext {
        sink: SINK.with(|slot| slot.borrow().clone()),
        cancelled: CANCELLED.with(|slot| slot.borrow().clone()),
    }
}

/// Runs `f` with `context` installed on this thread, restoring the previous one afterwards.
pub(crate) fn with_call_context<R>(context: CallContext, f: impl FnOnce() -> R) -> R {
    let previous = current_call_context();
    SINK.with(|slot| *slot.borrow_mut() = context.sink);
    CANCELLED.with(|slot| *slot.borrow_mut() = context.cancelled);
    let result = f();
    SINK.with(|slot| *slot.borrow_mut() = previous.sink);
    CANCELLED.with(|slot| *slot.borrow_mut() = previous.cancelled);
    result
}

/// True once the caller cancelled the call this thread is serving.
pub(crate) fn call_cancelled() -> bool {
    CANCELLED.with(|slot| slot.borrow().as_ref().is_some_and(|flag| flag.load(Ordering::Acquire)))
}

/// A progress line for the current call, if its caller asked for progress.
pub(crate) fn report_progress(message: &str) {
    SINK.with(|slot| {
        if let Some(sink) = slot.borrow().as_ref() {
            sink.send(message);
        }
    });
}
