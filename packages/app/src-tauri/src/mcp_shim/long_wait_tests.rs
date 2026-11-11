use super::*;
use std::cell::RefCell;

const TEST: Limits = Limits {
    cap_ms: 100,
    slice_ms: 40,
    beat: Duration::from_millis(30),
    min_gap: Duration::from_millis(5),
};

fn run_response(status: &str) -> Value {
    json!({"handle":"h1","operation_id":"op1","status":status,"revision":3,
        "lane_used":"terminal","watch_command":"npx potato-workspace watch h1","result":null})
}

fn wait_response(status: &str, result: &str) -> String {
    json!({"agents":[{"handle":"h1","status":status,"result":result,"revision":9}],"reason":"timeout"}).to_string()
}

struct Fake {
    posts: RefCell<Vec<Value>>,
    waits: RefCell<Vec<Value>>,
}

fn drive(
    body: Value,
    first: Value,
    waits: impl Fn(usize) -> Result<String, String>,
) -> (Result<Value, String>, Fake) {
    let fake = Fake { posts: RefCell::new(vec![]), waits: RefCell::new(vec![]) };
    let out = launch_and_wait_with(
        "/agents/run",
        body,
        None,
        TEST,
        |b| {
            fake.posts.borrow_mut().push(b.clone());
            Ok(first.to_string())
        },
        |b| {
            let n = fake.waits.borrow().len();
            fake.waits.borrow_mut().push(b.clone());
            waits(n)
        },
    )
    .map(|text| serde_json::from_str::<Value>(&text).expect("json"));
    (out, fake)
}

#[test]
fn settles_inside_the_same_call() {
    let (out, fake) = drive(
        json!({"task":"t","project_path":"P","wait_ms":2000}),
        run_response("running"),
        |n| Ok(if n < 2 { wait_response("running", "") } else { wait_response("completed", "done") }),
    );
    let out = out.expect("ok");
    assert_eq!(out["status"], "completed");
    assert_eq!(out["result"], "done");
    assert_eq!(out["lane_used"], "terminal", "run-only fields are kept");
    assert!(out.get("watch_command").is_none());
    assert_eq!(out["wait_extended"], true);
    assert!(out["waited_ms"].is_u64());
    assert_eq!(fake.posts.borrow().len(), 1);
    let waits = fake.waits.borrow();
    assert_eq!(waits[0]["handles"], json!(["h1"]));
    assert_eq!(waits[0]["project_path"], "P");
    assert_eq!(waits[0]["after_cursor"], 3);
    assert!(waits[0]["timeout_ms"].as_u64().unwrap() <= 40);
}

#[test]
fn a_wait_within_the_cap_is_one_unchanged_post() {
    let body = json!({"task":"t","wait_ms":100});
    let (out, fake) = drive(body.clone(), run_response("running"), |_| panic!("no wait"));
    let out = out.expect("ok");
    assert_eq!(*fake.posts.borrow(), vec![body]);
    assert!(out.get("wait_extended").is_none());
    assert_eq!(out["watch_command"], "npx potato-workspace watch h1");
    // No wait_ms at all: the body goes through untouched too.
    let body = json!({"task":"t"});
    let (_, fake) = drive(body.clone(), run_response("running"), |_| panic!("no wait"));
    assert_eq!(*fake.posts.borrow(), vec![body]);
}

#[test]
fn a_larger_wait_is_clamped_in_the_bridge_body() {
    let (_, fake) = drive(
        json!({"task":"t","wait_ms":500}),
        run_response("completed"),
        |_| panic!("settled already"),
    );
    assert_eq!(fake.posts.borrow()[0]["wait_ms"], 100);
    // Above the one hour ceiling still clamps to the cap on the wire.
    let (_, fake) = drive(json!({"wait_ms": 99_999_999_999u64}), run_response("completed"), |_| panic!());
    assert_eq!(fake.posts.borrow()[0]["wait_ms"], 100);
}

#[test]
fn the_deadline_keeps_the_watch_command() {
    let started = Instant::now();
    let (out, _) = drive(
        json!({"task":"t","wait_ms":250}),
        run_response("running"),
        |_| Ok(wait_response("running", "")),
    );
    let out = out.expect("ok");
    assert_eq!(out["status"], "running");
    assert_eq!(out["watch_command"], "npx potato-workspace watch h1");
    assert_eq!(out["wait_extended"], true);
    assert!(started.elapsed() >= Duration::from_millis(200));
}

#[test]
fn needs_input_stops_the_wait() {
    let (out, fake) = drive(
        json!({"task":"t","wait_ms":5000}),
        run_response("running"),
        |_| Ok(wait_response("needs_input", "")),
    );
    let out = out.expect("ok");
    assert_eq!(out["status"], "needs_input");
    assert_eq!(fake.waits.borrow().len(), 1);
}

#[test]
fn progress_is_sent_during_the_extended_wait() {
    let (tx, rx) = std::sync::mpsc::channel();
    let sink = ProgressSink::new(json!("tok"), tx);
    let context = CallContext { sink: Some(sink), cancelled: None };
    let (out, _) = with_call_context(context, || {
        drive(json!({"task":"t","wait_ms":300}), run_response("running"), |_| {
            std::thread::sleep(Duration::from_millis(15));
            Ok(wait_response("running", ""))
        })
    });
    out.expect("ok");
    let sent: Vec<String> = rx.try_iter().collect();
    assert!(!sent.is_empty());
    assert!(sent[0].contains("progressToken") && sent[0].contains("still running"));
}

#[test]
fn a_cancel_ends_the_wait() {
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(()).unwrap();
    let out = launch_and_wait_with(
        "/agents/run",
        json!({"wait_ms":5000}),
        Some(&rx),
        TEST,
        |_| Ok(run_response("running").to_string()),
        |_| panic!("cancelled before waiting"),
    );
    assert_eq!(out.unwrap_err(), REQUEST_CANCELLED_JSON);
}
