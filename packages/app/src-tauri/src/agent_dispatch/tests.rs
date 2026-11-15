use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;

struct Fake {
    devices: Vec<(&'static str, &'static str)>,
    on: Vec<&'static str>,
    answer: (u16, Value),
    seen: Mutex<Vec<(String, String, Value)>>,
}

impl Fake {
    fn new() -> Self {
        Self { devices: vec![("aa11bb22cc", "Mac mini"), ("dd33ee44ff", "Work laptop")], on: vec![], answer: (200, json!({ "handle": "h1" })), seen: Mutex::new(vec![]) }
    }
}

impl DeviceSender for Fake {
    fn resolve(&self, wanted: &str) -> Result<Target, String> {
        let l = wanted.to_lowercase();
        let hits: Vec<_> = self.devices.iter().filter(|(n, name)| name.to_lowercase() == l || n.starts_with(&l)).collect();
        match hits.as_slice() {
            [] => Err("No paired device is called that.".into()),
            [(n, name)] => Ok(Target { node: n.to_string(), name: name.to_string() }),
            _ => Err("More than one device matches.".into()),
        }
    }
    fn may_send(&self, node: &str) -> bool {
        self.on.contains(&node)
    }
    fn request(&self, node: &str, method: &str, path: &str, body: Value) -> Result<(u16, Value), String> {
        self.seen.lock().unwrap().push((node.into(), format!("{method} {path}"), body));
        Ok(self.answer.clone())
    }
}

fn run(f: &Fake, body: Value, remote: bool) -> Option<Result<Value, OperationError>> {
    intercept_with(Some(f), "POST", &["agents", "run"], body.to_string().as_bytes(), remote)
}

#[test]
fn off_by_default_and_nothing_is_sent() {
    let f = Fake::new();
    let e = run(&f, json!({ "task": "x", "account": "device:Mac mini" }), false).unwrap().unwrap_err();
    assert_eq!(e.code, "DEVICE_SEND_OFF");
    assert!(e.message.contains("Mac mini does not let agents send work to it"));
    assert!(f.seen.lock().unwrap().is_empty());
}

#[test]
fn on_forwards_without_account_worker_or_handle_and_names_the_device() {
    let mut f = Fake::new();
    f.on.push("aa11bb22cc");
    let ok = run(&f, json!({ "task": "x", "account": "device:mac MINI", "worker_id": "w", "handle": "h", "project_path": "D:/r" }), false).unwrap().unwrap();
    assert_eq!(ok["device"], "Mac mini");
    assert_eq!(ok["handle"], "h1");
    let seen = f.seen.lock().unwrap();
    assert_eq!(seen[0].0, "aa11bb22cc");
    assert_eq!(seen[0].1, "POST /agents/run");
    assert_eq!(seen[0].2, json!({ "task": "x", "project_path": "D:/r" }));
}

#[test]
fn ambiguous_and_unknown_names_are_plain_errors() {
    let mut f = Fake::new();
    f.devices.push(("aa11ffffff", "Other"));
    f.on.push("aa11bb22cc");
    assert_eq!(run(&f, json!({ "task": "x", "account": "device:aa11" }), false).unwrap().unwrap_err().code, "DEVICE_NOT_FOUND");
    assert_eq!(run(&f, json!({ "task": "x", "account": "device:nope" }), false).unwrap().unwrap_err().code, "DEVICE_NOT_FOUND");
}

#[test]
fn a_request_from_another_device_never_hops_on() {
    let mut f = Fake::new();
    f.on.push("aa11bb22cc");
    let e = run(&f, json!({ "task": "x", "account": "device:Mac mini" }), true).unwrap().unwrap_err();
    assert_eq!(e.code, "DEVICE_NO_HOPS");
    assert!(f.seen.lock().unwrap().is_empty());
}

#[test]
fn the_far_refusal_comes_back_in_its_own_words() {
    let mut f = Fake::new();
    f.on.push("aa11bb22cc");
    f.answer = (403, json!({ "code": "REMOTE_OFF", "hint": "That device does not let this PC run agents." }));
    let e = run(&f, json!({ "task": "x", "account": "device:Mac mini" }), false).unwrap().unwrap_err();
    assert_eq!(e.code, "REMOTE_OFF");
    assert!(e.message.contains("does not let this PC run agents"));
}

#[test]
fn no_sender_means_devices_is_off() {
    let e = intercept_with(None, "POST", &["agents", "run"], br#"{"task":"x","account":"device:a"}"#, false).unwrap().unwrap_err();
    assert_eq!(e.code, "DEVICES_OFF");
}

#[test]
fn everything_else_is_left_alone() {
    let f = Fake::new();
    assert!(run(&f, json!({ "task": "x", "account": "acc_123" }), false).is_none());
    assert!(run(&f, json!({ "task": "x" }), false).is_none());
    assert!(intercept_with(Some(&f), "GET", &["agents", "run"], b"{}", false).is_none());
    assert!(intercept_with(Some(&f), "POST", &["agents", "quick"], br#"{"account":"device:Mac mini"}"#, false).is_none());
    assert!(intercept_with(Some(&f), "POST", &["agents", "run"], b"not json", false).is_none());
}
