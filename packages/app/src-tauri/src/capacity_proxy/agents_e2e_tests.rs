//! Codex and Gemini with an API key, through the whole lend: request, accept, the borrower's shim, the lender's
//! forwarder, a fake upstream on this machine. Fake keys only; no call to OpenAI or Google is made here.
//!
//! The same checks per agent (`Case`): the borrower side has only the placeholder, the lender adds the real key,
//! usage is metered, a revoked or expired lend answers a plain 403. Plus the pane and chat environment each agent gets
//! and the sign-in the lender cannot offer.

use std::ffi::OsString;
use std::time::Duration;

use super::e2e_tests::{world2, World2};
use super::proxy_tests::{http, json_script, Script, LENDER_KEY};
use super::service::{Approval, LendAccount, LendProfile, LendWho};

const ENDED_BODY: &str = r#"{"error":{"type":"lend_ended","message":"This lend ended"}}"#;

/// A Responses API stream: input 31, output 7.
const CODEX_SSE: &str = concat!(
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"usage\":null}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":31,\"output_tokens\":7,\"total_tokens\":38}}}\n\n",
);

/// A Gemini stream: the prompt count repeats, the answer count grows; thinking tokens count as output.
const GEMINI_SSE: &str = concat!(
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":3}}\r\n\r\n",
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" there\"}]}}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":9,\"thoughtsTokenCount\":4,\"totalTokenCount\":25}}\r\n\r\n",
);

fn sse(text: &'static str) -> Script {
    // Cut mid line on purpose.
    let bytes = text.as_bytes();
    let mid = bytes.len() / 3;
    Script::Sse(vec![(bytes[..mid].to_vec(), 20), (bytes[mid..].to_vec(), 20)])
}

struct Case {
    agent: &'static str,
    reply: &'static str,
    /// The path the agent really asks, with the query it adds (and a key in the URL when the agent does that).
    asked: &'static str,
    /// What the upstream must see of it.
    sent: &'static str,
    /// The borrower's own headers: the placeholder, and what must not steer the lender's key.
    borrower: &'static [(&'static str, &'static str)],
    /// The header the lender's key arrives in at the upstream, and its exact value.
    auth: (&'static str, &'static str),
    /// Headers that must not reach the upstream at all.
    gone: &'static [&'static str],
    usage: (u64, u64),
    /// Paths the spec must refuse.
    refused: &'static [(&'static str, &'static str)],
}

const CODEX: Case = Case {
    agent: "codex",
    reply: CODEX_SSE,
    asked: "/v1/responses",
    sent: "/v1/responses",
    borrower: &[("authorization", "Bearer pm-lend"), ("openai-organization", "org-BORROWER"), ("openai-project", "proj-BORROWER"), ("openai-beta", "responses=experimental")],
    auth: ("authorization", "Bearer sk-lender-FAKE"),
    gone: &["openai-organization", "openai-project", "x-api-key", "cookie"],
    usage: (31, 7),
    refused: &[("POST", "/v1/chat/completions"), ("GET", "/v1/files"), ("POST", "/v1/responses/x/cancel"), ("GET", "/backend-api/codex/responses"), ("POST", "/v1/images/generations")],
};

const GEMINI: Case = Case {
    agent: "gemini",
    reply: GEMINI_SSE,
    asked: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=pm-lend",
    sent: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    borrower: &[("x-goog-api-key", "pm-lend"), ("x-goog-user-project", "proj-BORROWER"), ("authorization", "Bearer BORROWER-TOKEN")],
    auth: ("x-goog-api-key", "sk-lender-FAKE"),
    gone: &["x-goog-user-project", "authorization", "cookie"],
    usage: (12, 13),
    refused: &[("POST", "/v1beta/models/gemini-2.5-flash:predict"), ("POST", "/v1beta/cachedContents"), ("POST", "/v1beta/models/a/b:generateContent"), ("GET", "/v1beta/tunedModels"), ("POST", "/upload/v1beta/files")],
};

fn profile(w: &World2, agent: &str, name: &str) -> String {
    let p = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: name.into(),
            agent_ids: vec![agent.into()],
            account: LendAccount::Main,
            who: LendWho::Teammates,
            member_ids: vec![w.leo.member()],
            default_secs: 3600,
            max_secs: 7 * 24 * 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            keep_awake: true,
            has_key: false,
        })
        .unwrap();
    w.maya.lend.key_set(&p.id, LENDER_KEY).unwrap();
    p.id
}

/// Leo asks Maya for `agent`, Maya says yes; returns the grant id and the borrower's shim address.
async fn lend(w: &World2, agent: &str, secs: u64) -> (String, String) {
    let profile_id = profile(w, agent, &format!("Work {agent}"));
    let req = w.leo.lend.request(&w.maya.member(), None, agent, secs, "fix the build").unwrap();
    w.maya.pump();
    let grant = w.maya.lend.answer(&req.id, true, Some(&profile_id), None).await.unwrap().unwrap();
    w.leo.pump();
    for _ in 0..100 {
        if let Ok(env) = w.leo.lend.borrowed_launch_env(agent, &grant.id) {
            let base = env.set.iter().find(|(k, _)| k == "GOOGLE_GEMINI_BASE_URL").or_else(|| env.set.iter().find(|(k, _)| k == "LEND_KEY"));
            assert!(base.is_some(), "the pane env points at the proxy: {env:?}");
            let base = shim_base(w, agent, &grant.id);
            return (grant.id, base);
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("the borrower's shim did not start");
}

/// The shim's address, read back from what the pane is given (Gemini's variable, or Codex's config file).
fn shim_base(w: &World2, agent: &str, grant: &str) -> String {
    let env = w.leo.lend.borrowed_launch_env(agent, grant).unwrap();
    if let Some((_, v)) = env.set.iter().find(|(k, _)| k == "GOOGLE_GEMINI_BASE_URL") {
        return v.clone();
    }
    let home = &env.set.iter().find(|(k, _)| k == "CODEX_HOME").expect("a scratch CODEX_HOME").1;
    let text = std::fs::read_to_string(std::path::Path::new(home).join("config.toml")).unwrap();
    let url = text.lines().find_map(|l| l.strip_prefix("base_url = \"")).unwrap().trim_end_matches('"');
    url.strip_suffix("/v1").unwrap().to_string()
}

async fn ask(case: &Case, base: &str, path: &str, headers: &[(&str, &str)]) -> super::proxy_tests::Reply {
    let rest = base.strip_prefix("http://127.0.0.1:").unwrap();
    let (port, secret) = rest.split_once('/').unwrap();
    let mut all: Vec<(&str, &str)> = vec![("content-type", "application/json")];
    all.extend_from_slice(headers);
    let _ = case;
    http(port.parse().unwrap(), "POST", &format!("/{secret}{path}"), &all, br#"{"model":"test","stream":true}"#).await
}

async fn the_whole_lend(case: &Case) {
    let w = world2(sse(case.reply)).await;
    let (grant_id, base) = lend(&w, case.agent, 3600).await;

    // The agent's request, as it is made on the borrower's PC: only the placeholder, and headers that would steer the key.
    let reply = ask(case, &base, case.asked, case.borrower).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(reply.complete);
    assert_eq!(reply.body, case.reply.as_bytes(), "the stream is byte-identical");

    // The lender's key is the only credential the provider sees.
    let seen = w.up.requests();
    assert_eq!(seen.len(), 1);
    let r = &seen[0];
    assert_eq!(r.path, case.sent);
    assert_eq!(r.header(case.auth.0), Some(case.auth.1));
    for name in case.gone {
        assert_eq!(r.header(name), None, "{name} must not reach the provider");
    }
    for (k, v) in &r.headers {
        assert!(!v.contains("pm-lend") && !v.contains("BORROWER"), "{k}: {v}");
    }
    assert!(!r.path.contains("pm-lend"), "{}", r.path);

    // Usage is counted on both PCs.
    let usage = w.maya.lend.usage(&grant_id).unwrap();
    assert_eq!((usage.requests, usage.input_tokens, usage.output_tokens), (1, case.usage.0, case.usage.1));
    let mine = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((mine.requests, mine.input_tokens, mine.output_tokens), (1, case.usage.0, case.usage.1));

    // Anything outside the spec never leaves the lender.
    for (method, path) in case.refused {
        let rest = base.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, secret) = rest.split_once('/').unwrap();
        let denied = http(port.parse().unwrap(), method, &format!("/{secret}{path}"), &[], b"{}").await;
        assert_eq!(denied.status, 403, "{method} {path}");
    }
    assert_eq!(w.up.requests().len(), 1);

    // Revoke: a plain 403 at once, and nothing more reaches the provider.
    w.maya.lend.revoke(&grant_id).unwrap();
    let after = ask(case, &base, case.asked, case.borrower).await;
    assert_eq!((after.status, after.text().as_str()), (403, ENDED_BODY));
    assert_eq!(w.up.requests().len(), 1);
    w.leo.pump();
    assert_eq!(w.leo.lend.borrowed_launch_env(case.agent, &grant_id).unwrap_err(), "This lend ended");
}

async fn an_expired_lend(case: &Case) {
    let w = world2(json_script(200, "{}")).await;
    let (_grant, base) = lend(&w, case.agent, 2).await;
    assert_eq!(ask(case, &base, case.asked, case.borrower).await.status, 200);
    tokio::time::sleep(Duration::from_millis(2600)).await;
    let late = ask(case, &base, case.asked, case.borrower).await;
    assert_eq!((late.status, late.text().as_str()), (403, ENDED_BODY));
    assert_eq!(w.up.requests().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_with_an_api_key_goes_through_the_whole_lend() {
    the_whole_lend(&CODEX).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gemini_with_an_api_key_goes_through_the_whole_lend() {
    the_whole_lend(&GEMINI).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_codex_lend_answers_a_plain_403() {
    an_expired_lend(&CODEX).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_gemini_lend_answers_a_plain_403() {
    an_expired_lend(&GEMINI).await;
}

fn set<'a>(env: &'a crate::tui::LaunchEnv, name: &str) -> Option<&'a str> {
    env.set.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrowed_codex_terminal_gets_its_own_config_with_websockets_off_and_a_placeholder_key() {
    let w = world2(json_script(200, "{}")).await;
    let (grant_id, base) = lend(&w, "codex", 3600).await;
    let env = w.leo.lend.borrowed_launch_env("codex", &grant_id).unwrap();
    assert_eq!(set(&env, "LEND_KEY"), Some("pm-lend"));
    let home = set(&env, "CODEX_HOME").expect("a CODEX_HOME for this lend").to_string();
    assert!(home.contains(&grant_id) && home.ends_with("terminal"), "{home}");
    assert!(std::path::Path::new(&home).starts_with(&w.leo.dir), "inside the app's own folder, never the borrower's real Codex home");
    // The borrower's own keys and home are gone; the scratch home is not removed.
    for name in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_MODEL"] {
        assert!(env.remove.iter().any(|r| r == name), "{name} stays");
    }
    assert!(!env.remove.iter().any(|r| r == "CODEX_HOME" || r == "LEND_KEY"));
    let config = std::fs::read_to_string(std::path::Path::new(&home).join("config.toml")).unwrap();
    assert!(config.contains(&format!("base_url = \"{base}/v1\"")), "{config}");
    assert!(config.contains("supports_websockets = false") && config.contains("wire_api = \"responses\"") && config.contains("env_key = \"LEND_KEY\""));
    assert!(config.contains("model_provider = \"lend\""));
    assert!(!config.contains(LENDER_KEY) && !config.contains("pm-lend"), "no key in the file, the placeholder lives in the environment");
    assert!(base.starts_with("http://127.0.0.1:"), "{base}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrowed_codex_chat_authenticates_with_the_placeholder_key_and_the_base_url_is_in_its_own_home() {
    use crate::acp::config::{build_env, find_builtin, with_borrowed_chat, HostEnv};
    struct Host;
    impl HostEnv for Host {
        fn var(&self, name: &str) -> Option<OsString> {
            ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "CODEX_CONFIG"].contains(&name).then(|| OsString::from("borrower-own-FAKE"))
        }
        fn which(&self, _program: &str) -> Option<std::path::PathBuf> {
            None
        }
        fn adapters_dir(&self) -> std::path::PathBuf {
            "adapters".into()
        }
        fn homes_dir(&self) -> std::path::PathBuf {
            "homes".into()
        }
    }
    let lookup = |env: &[(OsString, OsString)], name: &str| env.iter().find(|(n, _)| n.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v.to_string_lossy().into_owned());

    let w = world2(json_script(200, "{}")).await;
    let (grant_id, base) = lend(&w, "codex", 3600).await;
    let chat = w.leo.lend.borrowed_chat("codex", &grant_id).unwrap();
    assert_eq!(chat.authenticate.as_deref(), Some("api-key"));
    assert_eq!(set(&chat.env, "CODEX_API_KEY"), Some("pm-lend"));
    assert_eq!(set(&chat.env, "OPENAI_API_KEY"), Some("pm-lend"));
    let home = set(&chat.env, "CODEX_HOME").unwrap().to_string();
    assert!(home.ends_with("chat") && home.contains(&grant_id), "{home}");
    let config = std::fs::read_to_string(std::path::Path::new(&home).join("config.toml")).unwrap();
    assert_eq!(config.trim(), format!("openai_base_url = \"{base}/v1\""));

    let mut cfg = find_builtin("codex").expect("codex has a chat adapter");
    let before = build_env(&cfg, &Host, None);
    assert_eq!(lookup(&before, "CODEX_HOME").as_deref(), Some("borrower-own-FAKE"), "what the lend must replace");
    with_borrowed_chat(&mut cfg, &chat);
    assert_eq!(cfg.authenticate_with.as_deref(), Some("api-key"));
    let env = build_env(&cfg, &Host, None);
    assert_eq!(lookup(&env, "CODEX_HOME").as_deref(), Some(home.as_str()), "the adapter uses the lend's own home");
    assert_eq!(lookup(&env, "CODEX_API_KEY").as_deref(), Some("pm-lend"));
    assert_eq!(lookup(&env, "OPENAI_API_KEY").as_deref(), Some("pm-lend"));
    assert!(env.iter().all(|(_, v)| !v.to_string_lossy().contains("borrower-own")), "none of the borrower's own values reach the adapter: {env:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrowed_gemini_terminal_gets_the_base_url_and_a_settings_file_that_picks_the_api_key() {
    let w = world2(json_script(200, "{}")).await;
    let (grant_id, base) = lend(&w, "gemini", 3600).await;
    let env = w.leo.lend.borrowed_launch_env("gemini", &grant_id).unwrap();
    assert_eq!(set(&env, "GOOGLE_GEMINI_BASE_URL"), Some(base.as_str()));
    assert_eq!(set(&env, "GEMINI_API_KEY"), Some("pm-lend"));
    let home = set(&env, "GEMINI_CLI_HOME").expect("a scratch home").to_string();
    let settings = std::fs::read_to_string(std::path::Path::new(&home).join(".gemini").join("settings.json")).unwrap();
    assert!(settings.contains("gemini-api-key"), "{settings}");
    for name in ["GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "CODE_ASSIST_ENDPOINT"] {
        assert!(env.remove.iter().any(|r| r == name), "{name} stays");
    }
    // There is no Gemini chat in this app, so a borrowed chat is refused in plain words, not half started.
    let chat = w.leo.lend.borrowed_chat("gemini", &grant_id).unwrap_err();
    assert!(chat.contains("Open it in a terminal"), "{chat}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_signed_in_with_chatgpt_cannot_be_offered_and_the_screen_data_says_so() {
    let w = world2(json_script(200, "{}")).await;
    let drivers = w.maya.lend.drivers();
    let codex = drivers.iter().find(|d| d.agent_id == "codex").unwrap();
    assert!(codex.api_key && codex.chat && !codex.account);
    assert!(codex.account_note.as_deref().unwrap().contains("ChatGPT is not supported yet"));
    let claude = drivers.iter().find(|d| d.agent_id == "claude").unwrap();
    assert!(claude.api_key && claude.account && claude.account_note.is_none(), "Claude is unchanged");
    let gemini = drivers.iter().find(|d| d.agent_id == "gemini").unwrap();
    assert!(gemini.api_key && !gemini.account && !gemini.chat && gemini.account_note.as_deref().unwrap().contains("not supported yet"));

    // The lender can't add a sign-in to lend, and a profile on one is refused.
    let err = w.maya.lend.account_lendable("codex").unwrap_err();
    assert!(err.contains("ChatGPT is not supported yet"), "{err}");
    assert!(w.maya.lend.account_lendable("claude").is_ok());
    let store = crate::accounts::Store::at(&w.maya.dir);
    let made = store.add_lend("codex", "Lend Codex").unwrap();
    let refused = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "ChatGPT".into(),
            agent_ids: vec!["codex".into()],
            account: LendAccount::Account { id: made.id },
            who: LendWho::MyPcs,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            keep_awake: true,
            has_key: false,
        })
        .unwrap_err();
    assert!(refused.contains("ChatGPT is not supported yet"), "{refused}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_key_for_one_agent_is_not_a_license_for_another() {
    // Gemini's profile cannot be asked for Codex: the request names the agent and the profile lists its agents.
    let w = world2(json_script(200, "{}")).await;
    let profile_id = profile(&w, "gemini", "Gemini only");
    let req = w.leo.lend.request(&w.maya.member(), None, "codex", 3600, "").unwrap();
    w.maya.pump();
    let err = w.maya.lend.answer(&req.id, true, Some(&profile_id), None).await.unwrap_err();
    assert!(!err.is_empty());
    assert!(w.up.requests().is_empty());
}
