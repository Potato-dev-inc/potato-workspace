//! `run_agent(review_by: {...})`: once the run has finished, ask the app for a second opinion by another agent
//! (`POST /agents/review`) and put its answer into the same result as `review`. The run itself is untouched: a
//! review that cannot happen is reported inside `review`, it never turns a finished run into an error.

use super::*;

/// Takes `review_by` out of the body (the run route does not know it). `None` when the caller did not ask.
pub(super) fn take_review_by(body: &mut Value) -> Option<Value> {
    let asked = body.as_object_mut()?.remove("review_by")?;
    asked.is_object().then_some(asked)
}

/// The `/agents/review` request for a finished run, or `None` when there is nothing to review (not finished
/// well, or no handle).
fn review_request(result: &Value, review_by: &Value, project: Option<&Value>) -> Option<Value> {
    if result.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    let handle = result.get("handle").and_then(Value::as_str)?;
    let mut request = json!({ "handle": handle });
    if let Some(project) = project {
        request["project_path"] = project.clone();
    }
    for key in ["agent_type", "model", "allow_same"] {
        if let Some(value) = review_by.get(key) {
            request[key] = value.clone();
        }
    }
    Some(request)
}

/// Adds `review` to a finished run's result. `ask` posts the review request.
pub(super) fn attach_review(
    response: String,
    review_by: Option<&Value>,
    project: Option<&Value>,
    ask: impl FnOnce(Value) -> Result<String, String>,
) -> String {
    let Some(review_by) = review_by else { return response };
    let Ok(mut result) = serde_json::from_str::<Value>(&response) else { return response };
    let status = result.get("status").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(request) = review_request(&result, review_by, project) else {
        // Still running (or failed): say why no review came, so the caller can ask later with review_agent.
        if let Some(object) = result.as_object_mut() {
            let why = if matches!(status.as_str(), "running" | "queued" | "starting" | "cancelling") {
                "the run is still going; call review_agent(handle) when it has finished"
            } else {
                "the run did not finish, so there is nothing to review"
            };
            object.insert("review".into(), json!({ "skipped": why }));
        }
        return result.to_string();
    };
    let review = match ask(request) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("review").cloned())
            .unwrap_or_else(|| json!({ "error": { "code": "REVIEW_FAILED", "message": "the review answer could not be read" } })),
        Err(error) => match serde_json::from_str::<Value>(&error) {
            Ok(v) => json!({ "error": v }),
            Err(_) => json!({ "error": { "code": "REVIEW_FAILED", "message": error } }),
        },
    };
    if let Some(object) = result.as_object_mut() {
        object.insert("review".into(), review);
    }
    result.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done() -> String {
        json!({"handle":"h1","status":"completed","result":"ok"}).to_string()
    }

    #[test]
    fn review_by_is_taken_out_of_the_run_request() {
        let mut body = json!({"task":"t","review_by":{"agent_type":"codex"}});
        assert_eq!(take_review_by(&mut body).unwrap()["agent_type"], "codex");
        assert!(body.get("review_by").is_none());
        let mut none = json!({"task":"t"});
        assert!(take_review_by(&mut none).is_none());
        let mut junk = json!({"review_by": true});
        assert!(take_review_by(&mut junk).is_none());
    }

    #[test]
    fn a_finished_run_gets_the_review_inside_the_same_result() {
        let asked = std::cell::RefCell::new(None);
        let out = attach_review(done(), Some(&json!({"agent_type":"codex","model":"m","allow_same":false})), Some(&json!("D:/repo")), |request| {
            *asked.borrow_mut() = Some(request);
            Ok(json!({"handle":"h1","review":{"by":"codex","verdict":"fail","findings":[{"file":"a.rs","line":1,"note":"BUG"}]}}).to_string())
        });
        let value: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["result"], "ok");
        assert_eq!(value["review"]["verdict"], "fail");
        assert_eq!(value["review"]["findings"][0]["note"], "BUG");
        let request = asked.borrow().clone().unwrap();
        assert_eq!(request["handle"], "h1");
        assert_eq!(request["agent_type"], "codex");
        assert_eq!(request["project_path"], "D:/repo");
    }

    #[test]
    fn a_run_that_did_not_finish_is_not_reviewed_and_says_why() {
        let running = json!({"handle":"h1","status":"running"}).to_string();
        let out: Value = serde_json::from_str(&attach_review(running, Some(&json!({})), None, |_| panic!("no review"))).unwrap();
        assert!(out["review"]["skipped"].as_str().unwrap().contains("review_agent"));
        let failed = json!({"handle":"h1","status":"failed"}).to_string();
        let out: Value = serde_json::from_str(&attach_review(failed, Some(&json!({})), None, |_| panic!("no review"))).unwrap();
        assert!(out["review"]["skipped"].as_str().unwrap().contains("did not finish"));
    }

    #[test]
    fn a_refused_review_keeps_the_run_result_and_carries_the_typed_error() {
        let refusal = json!({"code":"SAME_AGENT_REVIEWER","message":"pick another","recoverable":false}).to_string();
        let out: Value = serde_json::from_str(&attach_review(done(), Some(&json!({"agent_type":"claude"})), None, |_| Err(refusal))).unwrap();
        assert_eq!(out["status"], "completed");
        assert_eq!(out["review"]["error"]["code"], "SAME_AGENT_REVIEWER");
        let out: Value = serde_json::from_str(&attach_review(done(), Some(&json!({})), None, |_| Err("bridge down".into()))).unwrap();
        assert_eq!(out["review"]["error"]["code"], "REVIEW_FAILED");
    }

    #[test]
    fn without_review_by_the_response_is_untouched() {
        assert_eq!(attach_review(done(), None, None, |_| panic!("no review")), done());
    }
}
