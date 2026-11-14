//! Times the steps of the app's `setup` block: `mark("name")` after each step, `finish(dir)` writes one log
//! line and `<dir>/startup-last.json`, so a slow start shows which step took the time.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::path::Path;
use std::time::Instant;

pub const FILE_NAME: &str = "startup-last.json";

/// One timed step: its name, the ms it took since the step before, and the ms since the first mark.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Step {
    pub name: String,
    pub step_ms: u64,
    pub at_ms: u64,
}

#[derive(Debug)]
pub struct Trace {
    started: Instant,
    last: u64,
    steps: Vec<Step>,
}

impl Trace {
    pub fn new() -> Self {
        Self { started: Instant::now(), last: 0, steps: Vec::new() }
    }

    pub fn mark(&mut self, name: &str) -> u64 {
        let at_ms = self.started.elapsed().as_millis() as u64;
        let step_ms = at_ms.saturating_sub(self.last);
        self.last = at_ms;
        self.steps.push(Step { name: name.to_string(), step_ms, at_ms });
        step_ms
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    pub fn total_ms(&self) -> u64 {
        self.steps.last().map(|s| s.at_ms).unwrap_or(0)
    }

    /// One line: `startup_trace total_ms=120 steps=a:5,b:100,...` (name:ms for that step).
    pub fn line(&self) -> String {
        let steps: Vec<String> = self.steps.iter().map(|s| format!("{}:{}", s.name, s.step_ms)).collect();
        format!("startup_trace total_ms={} steps={}", self.total_ms(), steps.join(","))
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "total_ms": self.total_ms(), "steps": self.steps })
    }
}

static TRACE: Lazy<Mutex<Trace>> = Lazy::new(|| Mutex::new(Trace::new()));

/// Record that a setup step just ended. Cheap; safe from any thread.
pub fn mark(name: &str) {
    TRACE.lock().mark(name);
}

/// Logs the line and writes `<dir>/startup-last.json`. May be called again later (the background chores add
/// their end mark and rewrite it). A write failure is only logged.
pub fn finish(dir: &Path) {
    let trace = TRACE.lock();
    tracing::info!("{}", trace.line());
    if let Err(err) = write_json(dir, &trace) {
        tracing::debug!(%err, "startup trace file not written");
    }
}

fn write_json(dir: &Path, trace: &Trace) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(FILE_NAME), serde_json::to_vec_pretty(&trace.json())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_keep_their_order_and_the_total_is_the_last_time() {
        let mut t = Trace::new();
        t.mark("a");
        std::thread::sleep(std::time::Duration::from_millis(20));
        t.mark("b");
        t.mark("c");
        let names: Vec<&str> = t.steps().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert!(t.steps()[1].step_ms >= 15, "b waited ~20 ms: {:?}", t.steps());
        assert_eq!(t.total_ms(), t.steps()[2].at_ms);
        let sum: u64 = t.steps().iter().map(|s| s.step_ms).sum();
        assert_eq!(sum, t.total_ms(), "the step times add up to the total");
        assert!(t.line().starts_with("startup_trace total_ms="));
        assert!(t.line().contains(",b:"));
    }

    #[test]
    fn finish_writes_the_json_file() {
        let dir = std::env::temp_dir().join(format!("pm-startup-trace-{}", std::process::id()));
        let mut t = Trace::new();
        t.mark("only");
        write_json(&dir, &t).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(v["steps"][0]["name"], "only");
        assert!(v["total_ms"].is_u64());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
