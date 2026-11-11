//! Per-grant enforcement on the lender: when the lend ends, how much it may use, and what it has used.

use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio::time::Instant;

/// Why a lend stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    Expired,
    Revoked,
    Returned,
    Stopped,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Revoked => "revoked",
            Self::Returned => "returned",
            Self::Stopped => "stopped",
        }
    }
}

/// Optional caps on one lend.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Limits {
    pub max_requests: Option<u64>,
    pub max_tokens: Option<u64>,
}

/// What a lend has used so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Why a request was not admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Ended,
    Limit,
}

/// The gate of one lend. It has no background task: the deadline is checked when asked.
pub struct Gate {
    deadline: Instant,
    limits: Limits,
    usage: Mutex<Usage>,
    state: watch::Sender<Option<EndReason>>,
}

impl Gate {
    pub fn new(deadline: Instant, limits: Limits) -> Arc<Gate> {
        let (state, _) = watch::channel(None);
        Arc::new(Gate { deadline, limits, usage: Mutex::new(Usage::default()), state })
    }

    /// The reason the lend ended, if it has (the deadline counts once it has passed).
    pub fn ended(&self) -> Option<EndReason> {
        if let Some(reason) = *self.state.borrow() {
            return Some(reason);
        }
        if Instant::now() >= self.deadline {
            self.end(EndReason::Expired);
            return *self.state.borrow();
        }
        None
    }

    /// Ends the lend and wakes every waiter. The first reason wins; later calls change nothing.
    pub fn end(&self, reason: EndReason) {
        self.state.send_if_modified(|s| {
            if s.is_none() {
                *s = Some(reason);
                true
            } else {
                false
            }
        });
    }

    /// Resolves when the lend ends, or when the deadline passes (which ends it as `Expired`).
    pub async fn wait_end(&self) -> EndReason {
        let mut rx = self.state.subscribe();
        loop {
            if let Some(reason) = *rx.borrow_and_update() {
                return reason;
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(self.deadline) => {
                    self.end(EndReason::Expired);
                    let reason = *self.state.borrow();
                    return reason.unwrap_or(EndReason::Expired);
                }
            }
        }
    }

    /// Lets one request in (and counts it), or says why not. A limit does not end the lend.
    pub fn admit(&self) -> Result<(), Refusal> {
        if self.ended().is_some() {
            return Err(Refusal::Ended);
        }
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        if self.limits.max_requests.is_some_and(|max| usage.requests >= max) {
            return Err(Refusal::Limit);
        }
        if self.limits.max_tokens.is_some_and(|max| usage.input_tokens.saturating_add(usage.output_tokens) >= max) {
            return Err(Refusal::Limit);
        }
        usage.requests += 1;
        Ok(())
    }

    pub fn add_usage(&self, input: u64, output: u64) {
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        usage.input_tokens = usage.input_tokens.saturating_add(input);
        usage.output_tokens = usage.output_tokens.saturating_add(output);
    }

    pub fn usage(&self) -> Usage {
        *self.usage.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn the_deadline_ends_the_gate() {
        let gate = Gate::new(Instant::now() + Duration::from_secs(10), Limits::default());
        assert!(gate.admit().is_ok());
        assert_eq!(gate.ended(), None);
        tokio::time::advance(Duration::from_secs(11)).await;
        assert_eq!(gate.admit(), Err(Refusal::Ended));
        assert_eq!(gate.ended(), Some(EndReason::Expired));
    }

    #[tokio::test(start_paused = true)]
    async fn wait_end_wakes_on_end_and_on_deadline() {
        let gate = Gate::new(Instant::now() + Duration::from_secs(10), Limits::default());
        let g2 = gate.clone();
        let waiter = tokio::spawn(async move { g2.wait_end().await });
        tokio::time::sleep(Duration::from_secs(1)).await;
        gate.end(EndReason::Revoked);
        gate.end(EndReason::Returned);
        assert_eq!(waiter.await.unwrap(), EndReason::Revoked);

        let gate = Gate::new(Instant::now() + Duration::from_secs(5), Limits::default());
        assert_eq!(gate.wait_end().await, EndReason::Expired);
        assert_eq!(gate.ended(), Some(EndReason::Expired));
    }

    #[tokio::test]
    async fn limits_refuse_without_ending() {
        let far = Instant::now() + Duration::from_secs(3600);
        let gate = Gate::new(far, Limits { max_requests: Some(2), max_tokens: None });
        assert!(gate.admit().is_ok());
        assert!(gate.admit().is_ok());
        assert_eq!(gate.admit(), Err(Refusal::Limit));
        assert_eq!(gate.ended(), None);

        let gate = Gate::new(far, Limits { max_requests: None, max_tokens: Some(100) });
        assert!(gate.admit().is_ok());
        gate.add_usage(60, 40);
        assert_eq!(gate.admit(), Err(Refusal::Limit));
        assert_eq!(gate.usage(), Usage { requests: 1, input_tokens: 60, output_tokens: 40 });
    }

    #[tokio::test]
    async fn end_is_first_reason_wins() {
        let gate = Gate::new(Instant::now() + Duration::from_secs(60), Limits::default());
        gate.end(EndReason::Stopped);
        gate.end(EndReason::Revoked);
        assert_eq!(gate.ended(), Some(EndReason::Stopped));
        assert_eq!(gate.admit(), Err(Refusal::Ended));
        assert_eq!(EndReason::Stopped.as_str(), "stopped");
    }
}
