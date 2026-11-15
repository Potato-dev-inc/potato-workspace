//! The toast rules (which buttons), the link parsing, the one-time grants and the activation flow, all with
//! fakes: no window, no Windows API.

use super::activate::{self, Env, Outcome};
use super::rules::{self, Act, Grant, Grants, Redeem, Shown, Spec};
use super::*;
use crate::attention::answer::testing::{rec, FakeEnv};
use crate::attention::answer::{Caller, Reply, Request, Via};
use crate::attention::model::{Kind as ItemKind, State};
use crate::prompt_risk::RiskLevel;
use crate::push::hub::{Candidate, ItemRef, YesNo};
use crate::push::triggers::{Kind, PromptInfo, PromptRisk};
use parking_lot::Mutex;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn prompt(level: Option<RiskLevel>, text: &str, actionable: bool) -> PromptInfo {
    PromptInfo { prompt_id: "p1".into(), text: text.into(), actionable, risk: level.map(|level| PromptRisk { level, headline: "Read files".into() }) }
}

fn item(fingerprint: &str) -> ItemRef {
    ItemRef { id: "item-1".into(), occurrence: 1, fingerprint: fingerprint.into(), yes_no: None }
}

fn waiting(level: Option<RiskLevel>, text: &str, item: Option<ItemRef>) -> Candidate {
    Candidate {
        kind: Kind::WaitingInput,
        key: "pane-1".into(),
        pane_id: Some("pane-1".into()),
        agent_label: "Claude".into(),
        heading: Some("auth refactor".into()),
        prompt: Some(prompt(level, text, level == Some(RiskLevel::Low))),
        item,
        detail: None,
    }
}

fn question(text: &str, yes_no: bool) -> Candidate {
    let mut item = item("");
    item.id = "q-card".into();
    item.occurrence = 0;
    if yes_no {
        item.yes_no = Some(YesNo { yes: "c-yes".into(), no: "c-no".into() });
    }
    Candidate {
        kind: Kind::Question,
        key: "q-1".into(),
        pane_id: None,
        agent_label: "Claude".into(),
        heading: None,
        prompt: Some(PromptInfo { prompt_id: String::new(), text: text.into(), actionable: false, risk: None }),
        item: Some(item),
        detail: None,
    }
}

// --- which buttons -------------------------------------------------------------------------------

#[test]
fn a_calm_command_gets_allow_and_deny() {
    let c = waiting(Some(RiskLevel::Low), "Run command: ls", Some(item("f1")));
    assert_eq!(rules::buttons(&c), vec![Act::Allow, Act::Deny]);
}

#[test]
fn a_risky_or_unrated_command_gets_only_open() {
    for level in [Some(RiskLevel::Medium), Some(RiskLevel::High), None] {
        let c = waiting(level, "Run command: rm -rf ../", Some(item("f1")));
        assert_eq!(rules::buttons(&c), vec![Act::Open], "{level:?}");
    }
}

#[test]
fn an_unknown_card_or_a_cut_command_gets_only_open() {
    // The answer is checked against what the card showed: no card, no Allow.
    assert_eq!(rules::buttons(&waiting(Some(RiskLevel::Low), "Run command: ls", None)), vec![Act::Open]);
    assert_eq!(rules::buttons(&waiting(Some(RiskLevel::Low), "Run command: ls", Some(item("")))), vec![Act::Open]);
    // A command the toast would cut could hide what actually runs.
    let long = format!("Run command: {}", "x".repeat(200));
    assert_eq!(rules::buttons(&waiting(Some(RiskLevel::Low), &long, Some(item("f1")))), vec![Act::Open]);
}

#[test]
fn a_plain_yes_no_question_gets_yes_and_no() {
    assert_eq!(rules::buttons(&question("Deploy to staging?", true)), vec![Act::Yes, Act::No]);
}

#[test]
fn any_other_question_gets_only_open() {
    assert_eq!(rules::buttons(&question("Which branch?", false)), vec![Act::Open], "not a yes / no question");
    let long = format!("{}?", "Deploy ".repeat(20));
    assert_eq!(rules::buttons(&question(&long, true)), vec![Act::Open], "too long to show whole");
    let mut no_card = question("Deploy?", true);
    no_card.item = None;
    assert_eq!(rules::buttons(&no_card), vec![Act::Open], "the card is not known");
}

#[test]
fn the_kinds_that_are_decided_in_the_app_get_only_open() {
    for kind in [Kind::TrustGate, Kind::Consent, Kind::Budget, Kind::Limit, Kind::Error, Kind::RunFailed] {
        let mut c = waiting(Some(RiskLevel::Low), "Run command: ls", Some(item("f1")));
        c.kind = kind;
        assert_eq!(rules::buttons(&c), vec![Act::Open], "{kind:?}");
    }
}

#[test]
fn only_things_that_need_you_get_a_toast() {
    for kind in [Kind::WaitingInput, Kind::Question, Kind::TrustGate, Kind::Consent, Kind::Budget, Kind::Limit, Kind::Error, Kind::RunFailed] {
        assert!(rules::wants_toast(kind), "{kind:?}");
    }
    for kind in [Kind::RunFinished, Kind::CompanionReply, Kind::NightShift] {
        assert!(!rules::wants_toast(kind), "{kind:?}");
    }
}

// --- the links -----------------------------------------------------------------------------------

#[test]
fn a_link_round_trips_and_forgives_case_and_a_closing_slash() {
    for act in [Act::Allow, Act::Deny, Act::Yes, Act::No, Act::Open] {
        assert_eq!(rules::parse_link(&rules::link(act, NONCE)), Some((act, NONCE.to_string())));
    }
    let shout = format!("POTATO-WORKSPACE://TOAST/allow/{NONCE}/").replace("TOAST", "toast");
    assert_eq!(rules::parse_link(&shout), Some((Act::Allow, NONCE.to_string())));
}

#[test]
fn a_link_that_is_not_exactly_a_toast_button_is_rejected() {
    let long = format!("potato-workspace://toast/allow/{}", "a".repeat(500));
    let junk = [
        "".to_string(),
        "potato-workspace://toast/".into(),
        "potato-workspace://toast/allow".into(),
        "potato-workspace://toast/allow/".into(),
        format!("potato-workspace://toast/allow/{}", &NONCE[..31]),
        format!("potato-workspace://toast/allow/{NONCE}0"),
        format!("potato-workspace://toast/allow/{}", NONCE.to_uppercase()),
        format!("potato-workspace://toast/allow/{}", "g".repeat(32)),
        format!("potato-workspace://toast/allow/{NONCE}?x=1"),
        format!("potato-workspace://toast/allow/{NONCE}#x"),
        format!("potato-workspace://toast/allow/{NONCE}/extra"),
        format!("potato-workspace://toast/allow/{NONCE}//"),
        format!("potato-workspace://toast/ALLOW/{NONCE}"),
        format!("potato-workspace://toast/answer/{NONCE}"),
        format!("potato-workspace://toast/../{NONCE}"),
        format!("potato-workspace://join/{NONCE}"),
        format!("potato-workspace:toast/allow/{NONCE}"),
        format!("https://toast/allow/{NONCE}"),
        format!("\u{feff}potato-workspace://toast/allow/{NONCE}"),
        format!("potato-workspace://toast/allow/\u{0}{}", &NONCE[1..]),
        long,
    ];
    for url in junk {
        assert_eq!(rules::parse_link(&url), None, "{url:?}");
    }
    assert!(rules::is_toast_link(&format!("potato-workspace://toast/anything")));
    assert!(!rules::is_toast_link("potato-workspace://join/ABC"));
}

#[test]
fn nonces_are_32_hex_and_never_repeat() {
    let a = rules::new_nonce();
    let b = rules::new_nonce();
    assert_ne!(a, b);
    assert!(rules::parse_link(&rules::link(Act::Open, &a)).is_some());
}

// --- the toast -----------------------------------------------------------------------------------

fn spec_with(title: &str, lines: &[&str], acts: &[Act]) -> Spec {
    let buttons: Vec<(Act, String)> = acts.iter().map(|a| (*a, rules::link(*a, NONCE))).collect();
    Spec { tag: "pm-x".into(), title: title.into(), lines: lines.iter().map(|l| l.to_string()).collect(), buttons, open_link: rules::link(Act::Open, NONCE) }
}

#[test]
fn the_xml_escapes_everything_the_agent_wrote() {
    let xml = rules::toast_xml(&spec_with("a <b> & \"c\"", &["it's <script>"], &[Act::Allow, Act::Deny]));
    assert!(xml.contains("<text>a &lt;b&gt; &amp; &quot;c&quot;</text>"), "{xml}");
    assert!(xml.contains("<text>it&apos;s &lt;script&gt;</text>"), "{xml}");
    assert!(!xml.contains("<script>"));
    assert_eq!(xml.matches("<action ").count(), 2);
    assert!(xml.contains("content=\"Allow\"") && xml.contains("content=\"Deny\""));
    assert!(xml.contains(&format!("launch=\"potato-workspace://toast/open/{NONCE}\"")));
    assert!(xml.contains("activationType=\"protocol\""));
    // Control characters become spaces, so the XML stays well formed.
    assert!(!rules::toast_xml(&spec_with("a\u{0}b\u{7}c", &[], &[Act::Open])).contains('\u{0}'));
}

#[test]
fn a_note_has_text_and_no_buttons() {
    let xml = rules::note_xml("This question was already answered.");
    assert!(xml.contains("This question was already answered."));
    assert!(!xml.contains("<action"));
}

#[test]
fn the_words_are_a_title_then_at_most_two_lines() {
    let c = waiting(Some(RiskLevel::Low), "Run command: ls", Some(item("f1")));
    let (title, lines) = rules::lines(&rules::words(&c));
    assert_eq!(title, "auth refactor \u{b7} Needs you");
    assert_eq!(lines, vec!["Low risk \u{b7} Read files".to_string(), "Run command: ls \u{b7} Claude".to_string()]);
    let (_, none) = rules::lines(&crate::push::triggers::Words { title: "t".into(), body: String::new() });
    assert!(none.is_empty());
}

#[test]
fn a_risky_command_never_reaches_the_toast_text() {
    let c = waiting(Some(RiskLevel::High), "Run command: rm -rf ../", Some(item("f1")));
    let (_, lines) = rules::lines(&rules::words(&c));
    assert!(lines.iter().all(|l| !l.contains("rm -rf")), "{lines:?}");
}

#[test]
fn build_issues_one_grant_per_button_and_one_for_the_click() {
    let mut grants = Grants::default();
    let mut n = 0u32;
    let c = waiting(Some(RiskLevel::Low), "Run command: ls", Some(item("f1")));
    let spec = build(&c, 1_000, &mut grants, || {
        n += 1;
        format!("{n:032x}")
    });
    assert_eq!(spec.buttons.iter().map(|(a, _)| *a).collect::<Vec<_>>(), vec![Act::Allow, Act::Deny]);
    assert_eq!(grants.open_count(), 3, "Allow, Deny and the click that opens");
    assert_eq!(spec.tag, "pm-pane-1");
    let (act, nonce) = rules::parse_link(&spec.buttons[0].1).unwrap();
    assert_eq!(act, Act::Allow);
    let Redeem::Granted(grant) = grants.redeem(&nonce, act, 2_000) else { panic!("not granted") };
    assert_eq!((grant.choice.as_deref(), grant.item_id.as_str(), grant.occurrence, grant.fingerprint.as_str()), (Some("allow_once"), "item-1", 1, "f1"));
    assert_eq!(grant.pane_id.as_deref(), Some("pane-1"));
    assert_eq!(grant.prompt_id, "p1");
}

#[test]
fn an_open_only_toast_has_one_button_and_the_click_is_the_same_link() {
    let mut grants = Grants::default();
    let c = waiting(Some(RiskLevel::High), "Run command: rm -rf ../", Some(item("f1")));
    let spec = build(&c, 0, &mut grants, rules::new_nonce);
    assert_eq!(spec.buttons.len(), 1);
    assert_eq!(spec.buttons[0].0, Act::Open);
    assert_eq!(spec.open_link, spec.buttons[0].1);
    assert_eq!(grants.open_count(), 1);
}

#[test]
fn a_yes_no_toast_carries_the_questions_own_choice_ids() {
    // One toast per press: using a button ends the toast's other buttons.
    let choices: Vec<Option<String>> = [Act::Yes, Act::No]
        .iter()
        .map(|pressed| {
            let mut grants = Grants::default();
            let spec = build(&question("Deploy?", true), 0, &mut grants, rules::new_nonce);
            let (act, link) = spec.buttons.iter().find(|(a, _)| a == pressed).unwrap();
            let (_, nonce) = rules::parse_link(link).unwrap();
            let Redeem::Granted(g) = grants.redeem(&nonce, *act, 0) else { panic!("not granted") };
            g.choice
        })
        .collect();
    assert_eq!(choices, vec![Some("c-yes".to_string()), Some("c-no".to_string())]);
}

// --- grants and "not twice" ----------------------------------------------------------------------

fn grant(act: Act, group: &str, pane: Option<&str>, expires_ms: u64) -> Grant {
    Grant {
        act,
        group: group.into(),
        item_id: "item-1".into(),
        pane_id: pane.map(str::to_string),
        prompt_id: "p1".into(),
        occurrence: 1,
        fingerprint: "f1".into(),
        choice: Some("allow_once".into()),
        expires_ms,
    }
}

#[test]
fn a_grant_works_once_and_takes_the_other_buttons_with_it() {
    let mut grants = Grants::default();
    grants.add("a".into(), grant(Act::Allow, "g", None, 10_000), 0);
    grants.add("b".into(), grant(Act::Deny, "g", None, 10_000), 0);
    assert!(matches!(grants.redeem("a", Act::Allow, 1), Redeem::Granted(_)));
    assert_eq!(grants.redeem("a", Act::Allow, 2), Redeem::Spent, "the same button again");
    assert_eq!(grants.redeem("b", Act::Deny, 2), Redeem::Spent, "the other button of that toast");
    assert_eq!(grants.open_count(), 0);
}

#[test]
fn an_unknown_nonce_or_the_wrong_act_does_nothing() {
    let mut grants = Grants::default();
    grants.add("a".into(), grant(Act::Allow, "g", None, 10_000), 0);
    assert_eq!(grants.redeem("zzz", Act::Allow, 1), Redeem::Unknown);
    assert_eq!(grants.redeem("a", Act::Deny, 1), Redeem::Unknown, "a link edited to another act");
    assert!(matches!(grants.redeem("a", Act::Allow, 1), Redeem::Granted(_)), "and the real one still works");
}

#[test]
fn a_grant_expires() {
    let mut grants = Grants::default();
    grants.add("a".into(), grant(Act::Allow, "g", None, 5_000), 0);
    assert_eq!(grants.redeem("a", Act::Allow, 5_000), Redeem::Expired);
    assert_eq!(grants.redeem("a", Act::Allow, 5_001), Redeem::Spent);
}

#[test]
fn a_pane_that_moved_on_ends_its_answer_buttons_but_not_an_open_only_toast() {
    let mut grants = Grants::default();
    grants.add("a".into(), grant(Act::Allow, "g", Some("pane-1"), 10_000), 0);
    grants.add("o".into(), grant(Act::Open, "h", Some("pane-1"), 10_000), 0);
    grants.drop_pane("pane-1");
    assert_eq!(grants.redeem("a", Act::Allow, 1), Redeem::Spent);
    assert!(matches!(grants.redeem("o", Act::Open, 1), Redeem::Granted(_)));
}

#[test]
fn the_grant_table_stays_small() {
    let mut grants = Grants::default();
    for i in 0..1000u64 {
        grants.add(format!("n{i}"), grant(Act::Open, &format!("g{i}"), None, 10_000 + i), 0);
    }
    assert!(grants.open_count() <= 128);
}

#[test]
fn the_same_thing_is_not_toasted_twice_until_it_is_asked_again() {
    let mut shown = Shown::default();
    assert!(shown.admit("pane-1", "item-1:1", 0));
    assert!(!shown.admit("pane-1", "item-1:1", 1_000), "same card again");
    assert!(shown.admit("pane-1", "item-1:2", 1_000), "the same command asked again is a new occurrence");
    assert!(shown.admit("pane-2", "item-1:2", 1_000), "other panes are independent");
    shown.forget("pane-1");
    assert!(shown.admit("pane-1", "item-1:2", 2_000));
    assert!(shown.admit("pane-1", "item-1:2", 2_000 + rules::GRANT_TTL_MS), "after a while it may speak again");
}

// --- activation ----------------------------------------------------------------------------------

struct TestEnv {
    fake: FakeEnv,
    grants: Mutex<Grants>,
    notes: Mutex<Vec<String>>,
    opened: Mutex<Vec<Option<String>>>,
}

impl Env for TestEnv {
    fn now_ms(&self) -> u64 {
        crate::attention::answer::Env::now_ms(&self.fake)
    }
    fn answer(&self, caller: &Caller, item_id: &str, request: &Request) -> Reply {
        assert_eq!(caller.via, Via::DesktopToast);
        crate::attention::answer::answer(&self.fake, caller, item_id, request)
    }
    fn open(&self, pane_id: Option<&str>) {
        self.opened.lock().push(pane_id.map(str::to_string));
    }
    fn note(&self, text: &str) {
        self.notes.lock().push(text.to_string());
    }
    fn grants(&self) -> &Mutex<Grants> {
        &self.grants
    }
}

/// An app showing a low-risk approval on `pane-1`, and the toast that announced it.
fn approval_env() -> (TestEnv, Spec) {
    let fake = FakeEnv::showing("pane-1", rec("p1", "Run command: ls", "low"), 1);
    let prompt = fake.items.lock()[0].prompt.clone().unwrap();
    let env = TestEnv { fake, grants: Mutex::new(Grants::default()), notes: Mutex::new(Vec::new()), opened: Mutex::new(Vec::new()) };
    let card = ItemRef { id: env.fake.item_id(), occurrence: prompt.occurrence, fingerprint: prompt.fingerprint, yes_no: None };
    let c = waiting(Some(RiskLevel::Low), "Run command: ls", Some(card));
    let spec = build(&c, 1_000_000, &mut env.grants.lock(), rules::new_nonce);
    (env, spec)
}

fn link_of(spec: &Spec, act: Act) -> String {
    spec.buttons.iter().find(|(a, _)| *a == act).map(|(_, l)| l.clone()).unwrap_or_else(|| spec.open_link.clone())
}

#[test]
fn allow_answers_through_the_attention_route_with_its_audit_line() {
    let (env, spec) = approval_env();
    let outcome = activate::activate(&env, &link_of(&spec, Act::Allow));
    assert_eq!(outcome, Outcome::Answered("Allowed once".into()));
    assert_eq!(env.fake.writes(), 1);
    assert_eq!(env.fake.typed.lock()[0], ("pane-1".to_string(), "allow_once".to_string()));
    assert_eq!(env.fake.audits.lock().as_slice(), ["Answered from a notification on this PC: Allowed once"]);
    // The card says the person at the PC answered, not a phone.
    let notes = env.fake.notes.lock();
    let resolution = &notes[0].1;
    assert_eq!(resolution.by.as_deref(), Some("desktop"));
    assert_eq!((resolution.device_name.clone(), resolution.device_id.clone()), (None, None));
    assert_eq!(env.notes.lock().as_slice(), ["Allowed once"]);
    assert_eq!(env.fake.items.lock()[0].state, State::Resolved);
}

#[test]
fn deny_types_the_deny_choice() {
    let (env, spec) = approval_env();
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Deny)), Outcome::Answered("Denied".into()));
    assert_eq!(env.fake.typed.lock()[0].1, "deny");
}

#[test]
fn pressing_a_second_button_or_the_same_one_again_types_nothing() {
    let (env, spec) = approval_env();
    activate::activate(&env, &link_of(&spec, Act::Allow));
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Deny)), Outcome::Stale(rules::MSG_ANSWERED));
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Allow)), Outcome::Stale(rules::MSG_ANSWERED));
    assert_eq!(env.fake.writes(), 1, "one key, whatever was pressed after");
    assert_eq!(env.fake.audits.lock().len(), 1);
    assert_eq!(env.notes.lock().last().map(String::as_str), Some(rules::MSG_ANSWERED));
}

#[test]
fn an_answer_the_phone_gave_first_is_reported_not_repeated() {
    let (env, spec) = approval_env();
    // The phone answered while the toast sat in the Action Center.
    crate::attention::answer::Env::note_resolution(
        &env.fake,
        "approval:pane-1",
        crate::attention::model::Resolution { state: "answered".into(), by: Some("phone".into()), choice_label: Some("Denied".into()), at_ms: 1, ..Default::default() },
    );
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Allow)), Outcome::Stale(rules::MSG_ANSWERED));
    assert_eq!(env.fake.writes(), 0);
}

#[test]
fn a_prompt_that_changed_since_the_toast_is_not_answered() {
    let (env, spec) = approval_env();
    *env.fake.occurrence.lock() = 2;
    env.fake.items.lock()[0].prompt.as_mut().unwrap().occurrence = 2;
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Allow)), Outcome::Stale(rules::MSG_CHANGED));
    assert_eq!(env.fake.writes(), 0);
}

#[test]
fn an_expired_toast_types_nothing() {
    let (env, spec) = approval_env();
    *env.fake.now.lock() = 1_000_000 + rules::GRANT_TTL_MS + 1;
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Allow)), Outcome::Stale(rules::MSG_EXPIRED));
    assert_eq!(env.fake.writes(), 0);
    assert_eq!(env.notes.lock().as_slice(), [rules::MSG_EXPIRED]);
}

#[test]
fn a_link_nobody_issued_does_nothing_and_says_nothing() {
    let (env, _spec) = approval_env();
    for url in [rules::link(Act::Allow, NONCE), "potato-workspace://toast/allow/not-a-nonce".to_string(), "potato-workspace://join/ABCDEFGHJKMNPQRS".to_string(), String::new()] {
        assert_eq!(activate::activate(&env, &url), Outcome::Ignored, "{url}");
    }
    assert_eq!(env.fake.writes(), 0);
    assert!(env.notes.lock().is_empty());
    assert!(env.opened.lock().is_empty());
}

#[test]
fn open_brings_the_app_forward_on_that_chat_and_types_nothing() {
    let (env, spec) = approval_env();
    assert_eq!(activate::activate(&env, &spec.open_link), Outcome::Opened);
    assert_eq!(env.opened.lock().as_slice(), [Some("pane-1".to_string())]);
    assert_eq!(env.fake.writes(), 0);
    // The click ended the toast's answer buttons too.
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Allow)), Outcome::Stale(rules::MSG_ANSWERED));
}

#[test]
fn a_yes_no_question_is_answered_with_the_questions_own_choice() {
    let (env, _) = approval_env();
    {
        let mut items = env.fake.items.lock();
        items[0].kind = ItemKind::Question;
        items[0].key = "question:q-9".into();
        items[0].pane = None;
        items[0].prompt = None;
    }
    let mut card = item("");
    card.id = env.fake.item_id();
    card.occurrence = 0;
    card.yes_no = Some(YesNo { yes: "c-yes".into(), no: "c-no".into() });
    let mut c = question("Deploy?", true);
    c.item = Some(card);
    let spec = build(&c, 1_000_000, &mut env.grants.lock(), rules::new_nonce);
    assert_eq!(spec.buttons.iter().map(|(a, _)| *a).collect::<Vec<_>>(), vec![Act::Yes, Act::No]);
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::No)), Outcome::Answered("c-no".into()));
    assert_eq!(env.fake.audits.lock().len(), 1);
    assert_eq!(activate::activate(&env, &link_of(&spec, Act::Yes)), Outcome::Stale(rules::MSG_ANSWERED));
}

// --- the setting ---------------------------------------------------------------------------------

#[test]
fn the_pc_switch_is_on_until_the_person_turns_it_off() {
    let dir = std::env::temp_dir().join(format!("pm-toast-prefs-{}", std::process::id()));
    let store = crate::notify_levels::Store::new(dir.join("notify-levels.json"));
    assert!(store.get().desktop_toasts, "on by default");
    assert!(!store.set_desktop_toasts(false).desktop_toasts);
    // It is kept on disk, and the other choices are untouched.
    let again = crate::notify_levels::Store::new(dir.join("notify-levels.json"));
    assert!(!again.get().desktop_toasts);
    assert_eq!(again.get().quiet, crate::notify_levels::QuietHours::default());
    // A settings file from before this switch existed reads as on.
    std::fs::write(dir.join("old.json"), r#"{"bells":{},"imported":true}"#).unwrap();
    assert!(crate::notify_levels::Store::new(dir.join("old.json")).get().desktop_toasts);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_debug_build_shows_no_toast() {
    // Only an installed build has the AppUserModelID Windows needs.
    assert!(!available());
    assert!(!listening());
}
