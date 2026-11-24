//! A read that spawns git is kept for a moment: a screen that asks the same thing ten times in a second (a chat switch asks
//! for every pane's branch) runs it once. The first caller computes while the others wait on that key, then read its answer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Slot<T> = Arc<Mutex<Option<(Instant, T)>>>;

pub struct BriefCache<T> {
    slots: Mutex<HashMap<String, Slot<T>>>,
    ttl: Duration,
}

impl<T: Clone> BriefCache<T> {
    pub fn new(ttl: Duration) -> Self {
        Self { slots: Mutex::new(HashMap::new()), ttl }
    }

    /// The kept answer for `key` while it is younger than the lifetime, else `work()` (kept in turn).
    pub fn get_or(&self, key: &str, work: impl FnOnce() -> T) -> T {
        let slot = {
            let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            if slots.len() > 256 {
                slots.retain(|_, s| s.try_lock().map(|g| g.as_ref().is_some_and(|(at, _)| at.elapsed() < self.ttl)).unwrap_or(true));
            }
            slots.entry(key.to_string()).or_default().clone()
        };
        let mut held = slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, value)) = held.as_ref() {
            if at.elapsed() < self.ttl {
                return value.clone();
            }
        }
        let value = work();
        *held = Some((Instant::now(), value.clone()));
        value
    }

    pub fn clear(&self) {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn many_asks_at_once_run_the_work_once() {
        let cache = Arc::new(BriefCache::<u32>::new(Duration::from_secs(5)));
        let runs = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (cache, runs) = (cache.clone(), runs.clone());
                std::thread::spawn(move || {
                    cache.get_or("k", || {
                        runs.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(30));
                        7
                    })
                })
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap(), 7);
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        cache.clear();
        assert_eq!(cache.get_or("k", || 9), 9);
    }

    #[test]
    fn an_old_answer_is_asked_again() {
        let cache = BriefCache::<u32>::new(Duration::from_millis(1));
        assert_eq!(cache.get_or("k", || 1), 1);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(cache.get_or("k", || 2), 2);
    }
}
