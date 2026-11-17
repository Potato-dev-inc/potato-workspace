//! Who is driving a chat: this PC, or another device (a paired phone, another PC). Plain state with an injected clock, so
//! the tests need no sleeping.
//!
//! - A device that sends a message, or tells the PC it is typing, becomes the **driver**. The desktop shows a chip
//!   "OPPO Reno13 is typing..." / "OPPO Reno13 is driving" with **Take back**.
//! - The person sending from this PC means this PC drives: there is no driver then.
//! - **Take back** makes this PC the driver on purpose. The other device sees "Ren's PC took this back", and until it
//!   taps **Take over** its messages are refused with a sentence (a lock, 30 minutes at most). Nothing else changes: the
//!   device keeps the rights the person gave it, and the bridge checks them as always.

use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// How long one "typing" signal counts.
pub const TYPING_FOR: Duration = Duration::from_secs(6);
/// A device that went quiet this long is not the driver any more.
pub const DRIVER_IDLE: Duration = Duration::from_secs(10 * 60);
/// The most a "took this back" lock lasts.
pub const LOCK_FOR: Duration = Duration::from_secs(30 * 60);

pub const TOOK_BACK_CODE: &str = "TOOK_BACK";

#[derive(Debug, Clone)]
struct Driver {
    id: String,
    last: Instant,
    typing_until: Option<Instant>,
}

#[derive(Debug, Clone)]
struct Lock {
    /// The device that was driving when the PC took it back.
    from: Option<String>,
    at: Instant,
}

#[derive(Debug, Default)]
pub struct Drive {
    driver: Option<Driver>,
    lock: Option<Lock>,
}

impl Drive {
    fn driver_now(&self, now: Instant) -> Option<&Driver> {
        self.driver.as_ref().filter(|d| now.duration_since(d.last) < DRIVER_IDLE)
    }

    fn lock_now(&self, now: Instant) -> Option<&Lock> {
        self.lock.as_ref().filter(|l| now.duration_since(l.at) < LOCK_FOR)
    }

    /// True when a message from `from` (`None`: this PC) must be refused: the PC took this back and the device has
    /// not taken it over.
    pub fn refuses(&self, from: Option<&str>, now: Instant) -> bool {
        from.is_some() && self.lock_now(now).is_some()
    }

    /// A device is typing into the chat right now.
    pub fn typing_now(&self, now: Instant) -> bool {
        self.driver_now(now).and_then(|d| d.typing_until).is_some_and(|until| until > now)
    }

    /// A device says it is typing. `false`: refused because the PC took this back.
    pub fn typing(&mut self, id: &str, now: Instant) -> bool {
        if self.refuses(Some(id), now) {
            return false;
        }
        self.driver = Some(Driver { id: id.to_string(), last: now, typing_until: Some(now + TYPING_FOR) });
        true
    }

    /// A message went in. `from` is the device (`None`: this PC, which then drives and ends any lock).
    pub fn sent(&mut self, from: Option<&str>, now: Instant) {
        match from {
            Some(id) => self.driver = Some(Driver { id: id.to_string(), last: now, typing_until: None }),
            // This PC drives. A "took this back" lock stays: the other device still has to take over on purpose.
            None => self.driver = None,
        }
    }

    /// "Take back": this PC drives now and the other device is told. `None`: nobody else was driving.
    pub fn take_back(&mut self, now: Instant) -> Option<String> {
        let driver = self.driver_now(now)?.id.clone();
        self.driver = None;
        self.lock = Some(Lock { from: Some(driver.clone()), at: now });
        Some(driver)
    }

    /// "Take over" from a device: it drives again and the lock ends.
    pub fn claim(&mut self, id: &str, now: Instant) {
        self.lock = None;
        self.driver = Some(Driver { id: id.to_string(), last: now, typing_until: None });
    }

    /// What the chat's state says. Absent (`Null`) when this PC drives and nothing was taken back.
    /// `name_of` gives the name to show for a device id (the identity record's, so a rename shows here).
    pub fn view(&self, now: Instant, name_of: &dyn Fn(&str) -> String) -> Value {
        let driver = self.driver_now(now).map(|d| {
            let typing_ms = d.typing_until.and_then(|t| t.checked_duration_since(now)).map(|left| left.as_millis() as u64).unwrap_or(0);
            json!({ "id": d.id, "name": name_of(&d.id), "typing": typing_ms > 0, "typing_ms": typing_ms })
        });
        let took_back = self.lock_now(now).map(|l| json!({ "by": crate::device_identity::LOCAL_ID, "by_name": name_of(crate::device_identity::LOCAL_ID), "from": l.from }));
        if driver.is_none() && took_back.is_none() {
            return Value::Null;
        }
        json!({ "driver": driver, "took_back": took_back })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(id: &str) -> String {
        match id {
            "local" => "Ren's PC".into(),
            other => format!("name of {other}"),
        }
    }

    #[test]
    fn a_phone_that_types_then_sends_drives_until_this_pc_sends() {
        let t0 = Instant::now();
        let mut d = Drive::default();
        assert!(d.view(t0, &names).is_null());
        assert!(d.typing("ph", t0));
        let v = d.view(t0, &names);
        assert_eq!(v["driver"]["typing"], true);
        assert_eq!(v["driver"]["name"], "name of ph");
        // The typing signal runs out; the phone still drives.
        let v = d.view(t0 + TYPING_FOR + Duration::from_secs(1), &names);
        assert_eq!(v["driver"]["typing"], false);
        assert_eq!(v["driver"]["id"], "ph");
        d.sent(Some("ph"), t0);
        assert_eq!(d.view(t0, &names)["driver"]["typing"], false);
        d.sent(None, t0);
        assert!(d.view(t0, &names).is_null());
    }

    #[test]
    fn a_quiet_driver_is_forgotten() {
        let t0 = Instant::now();
        let mut d = Drive::default();
        d.sent(Some("ph"), t0);
        assert!(d.view(t0 + DRIVER_IDLE + Duration::from_secs(1), &names).is_null());
        assert!(d.take_back(t0 + DRIVER_IDLE + Duration::from_secs(1)).is_none());
    }

    #[test]
    fn taking_back_locks_the_other_device_out_until_it_takes_over() {
        let t0 = Instant::now();
        let mut d = Drive::default();
        d.sent(Some("ph"), t0);
        assert_eq!(d.take_back(t0).as_deref(), Some("ph"));
        let v = d.view(t0, &names);
        assert!(v["driver"].is_null());
        assert_eq!(v["took_back"]["by_name"], "Ren's PC");
        assert_eq!(v["took_back"]["from"], "ph");
        assert!(d.refuses(Some("ph"), t0));
        assert!(!d.typing("ph", t0), "typing is refused too");
        assert!(!d.refuses(None, t0), "this PC always may");
        d.claim("ph", t0);
        assert!(!d.refuses(Some("ph"), t0));
        assert_eq!(d.view(t0, &names)["driver"]["id"], "ph");
    }

    #[test]
    fn the_lock_ends_by_itself_but_not_when_this_pc_sends() {
        let t0 = Instant::now();
        let mut d = Drive::default();
        d.sent(Some("ph"), t0);
        d.take_back(t0);
        assert!(!d.refuses(Some("ph"), t0 + LOCK_FOR + Duration::from_secs(1)));
        d.sent(Some("ph"), t0);
        d.take_back(t0);
        d.sent(None, t0);
        assert!(d.refuses(Some("ph"), t0), "this PC sending does not give it back");
    }
}
