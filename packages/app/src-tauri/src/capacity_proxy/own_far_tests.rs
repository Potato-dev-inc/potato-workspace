//! "Use my own agents" (P6.1): the lender's own click makes the lend; nothing is made because the far side asked. A is the lender (the
//! PC the person drives from), B the PC that runs the agent.

use std::sync::atomic::Ordering;
use std::time::Duration;

use super::own_tests::{borrowed_up, my_pcs_profile, now, pause, two, A_HEX, B_HEX};
use super::service::own_far::NO_SIGNIN;
use super::service::{Approval, Direction, GrantEnd, GrantState, LendAccount, LendProfile, LendWho};

async fn ask(b: &super::own_tests::Pc, offer: &super::service::FarOffer, secs: u64) -> Result<String, String> {
    let (lend, offer_ref, profile, agent) = (b.lend.clone(), offer.offer_ref.clone(), offer.profile_id.clone(), "claude".to_string());
    tokio::task::spawn_blocking(move || lend.ask_lender(A_HEX, &agent, &offer_ref, Some(&profile), secs)).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lenders_own_click_makes_the_lend_and_the_far_pc_gets_a_chat_ready_grant() {
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    assert_eq!((offer.profile_id.as_str(), offer.secs, offer.grant_id.is_none()), (profile.as_str(), 12 * 3600, true));
    assert_eq!(offer.offer_ref.len(), 32);
    // No grant exists until the other PC asks.
    assert!(a.lend.state(true).grants.is_empty());
    let grant_id = ask(&b, &offer, offer.secs).await.unwrap();
    borrowed_up(&b, &grant_id).await;
    let lent = a.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.direction, lent.state, lent.peer_node.as_str()), (Direction::Out, GrantState::Active, B_HEX));
    assert!(lent.ends_ms > now() + 11 * 3600 * 1000, "a rolling 12 hours");
    // Only the lender's own PC may start a chat on it, and only for this agent.
    assert!(b.lend.grant_lent_by(&grant_id, "claude", A_HEX));
    assert!(!b.lend.grant_lent_by(&grant_id, "claude", &"cc".repeat(32)), "another PC's call cannot use it");
    assert!(!b.lend.grant_lent_by(&grant_id, "codex", A_HEX));
    assert!(!b.lend.grant_lent_by("lg_other", "claude", A_HEX));
    // The far start with no sign-in named finds the lend by the CALLING PC's node (A, the lender), and only that PC's, for that agent.
    assert_eq!(b.lend.grant_from("claude", A_HEX).as_deref(), Some(grant_id.as_str()));
    assert_eq!(b.lend.grant_from("Claude", A_HEX).as_deref(), Some(grant_id.as_str()));
    assert_eq!(b.lend.grant_from("claude", &"cc".repeat(32)), None, "another PC's call gets no lend");
    assert_eq!(b.lend.grant_from("codex", A_HEX), None);
    assert_eq!(a.lend.grant_from("claude", B_HEX), None, "the lender holds no borrowed grant");
    // A default start with no one named takes the newest active lend of that agent from anyone.
    assert_eq!(b.lend.newest_borrow("claude").as_deref(), Some(grant_id.as_str()));
    assert_eq!(b.lend.newest_borrow("codex"), None);
    // A second chat on the same PC and agent uses the lend that runs.
    let again = a.lend.far_offer(B_HEX, "claude").unwrap();
    assert_eq!(again.grant_id.as_deref(), Some(grant_id.as_str()));
    assert!(again.offer_ref.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_nobody_promised_is_never_answered_by_itself() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    // The far side asks, with no promise, a made-up one, and a promise-shaped one the lender never wrote.
    b.lend.request_own(A_HEX, "claude", 3600, "please", None, None).unwrap();
    b.lend.request_own_ref(A_HEX, "claude", 3600, "", None, None, Some("made-up-ref")).unwrap();
    b.lend.request_own_ref(A_HEX, "claude", 3600, "", None, None, Some(&"ab".repeat(16))).unwrap();
    pause(300).await;
    let state = a.lend.state(true);
    assert_eq!(state.requests_in.len(), 3, "each waits for the person here, as before");
    assert!(state.requests_in.iter().all(|r| r.state == super::service::RequestState::Open));
    assert!(state.grants.is_empty(), "nothing is minted because the far side asked");
    assert!(b.lend.state(true).grants.is_empty());
    // A promise for one agent is no use for a request that names the right words but another PC.
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    let other = format!("node:{}", "cc".repeat(32));
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &other, "claude", None, 60).is_none(), "a promise is for one PC");
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &format!("node:{B_HEX}"), "codex", None, 60).is_none(), "and one agent");
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &format!("node:{B_HEX}"), "claude", Some("lp_other"), 60).is_none(), "and one profile");
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &format!("node:{B_HEX}"), "claude", None, 13 * 3600).is_none(), "and no more time than promised");
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &format!("node:{B_HEX}"), "Claude", None, 60).is_some());
    assert!(a.lend.claim_own_promise(&offer.offer_ref, &format!("node:{B_HEX}"), "claude", None, 60).is_none(), "once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_promise_makes_one_grant_even_if_the_same_words_come_again() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    let first = ask(&b, &offer, 3600).await.unwrap();
    borrowed_up(&b, &first).await;
    // The same promise again (a replay by the far side) starts nothing; the request waits for a person.
    b.lend.request_own_ref(A_HEX, "claude", 3600, "", None, None, Some(&offer.offer_ref)).unwrap();
    pause(300).await;
    let grants = a.lend.state(true).grants;
    assert_eq!(grants.iter().filter(|g| g.direction == Direction::Out).count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nothing_to_lend_says_sign_in_for_lending_first_and_makes_no_promise() {
    let (a, _b, _mem) = two();
    let err = a.lend.far_offer(B_HEX, "claude").unwrap_err();
    assert!(err.starts_with(&NO_SIGNIN), "{err}");
    // A profile with no key and no lend sign-in is the same.
    a.lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "Empty".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::MyPcs,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 7 * 24 * 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            keep_awake: false,
            has_key: false,
            show_usage: false,
        })
        .unwrap();
    assert!(a.lend.far_offer(B_HEX, "claude").unwrap_err().starts_with(&NO_SIGNIN));
    // Not my PC, and not an agent that has a lend spec.
    assert_eq!(a.lend.far_offer(&"cc".repeat(32), "claude").unwrap_err(), "That PC is not one of yours.");
    let _ = my_pcs_profile(&a.lend);
    assert!(a.lend.far_offer(B_HEX, "no-such-agent").unwrap_err().contains("can't be lent"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lend_rolls_on_while_a_chat_lives_and_the_far_pc_hears_it() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    // A short first lend, so the end can be watched (the test minimum is one second).
    let grant_id = ask(&b, &offer, 4).await.unwrap();
    borrowed_up(&b, &grant_id).await;
    let before = b.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap().ends_ms;
    assert!(before < now() + 6_000);
    let to = a.lend.renew_far(&grant_id).unwrap();
    assert!(to > now() + 11 * 3600 * 1000);
    let after = b.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap().ends_ms;
    assert!(after > before + 11 * 3600 * 1000, "the far PC took the later end");
    // Past the first end both sides still stand: nothing expired it.
    pause(4500).await;
    for pc in [&a, &b] {
        assert_eq!(pc.lend.state(true).grants.iter().find(|g| g.id == grant_id).unwrap().state, GrantState::Active);
    }
    assert!(b.lend.borrowed_launch_env("claude", &grant_id).is_ok());
    // A lend not to one of my PCs, or one that is over, cannot be renewed.
    assert!(a.lend.renew_far("lg_nothing").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lend_to_a_pc_the_account_dropped_is_taken_back() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    let grant_id = ask(&b, &offer, offer.secs).await.unwrap();
    borrowed_up(&b, &grant_id).await;
    // The account drops the far PC: it is not in my list of PCs any more. (Its link is cut too, so only this side can end it.)
    a.wire.gone.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        if a.lend.state(true).grants.iter().any(|g| g.id == grant_id && g.state == GrantState::Ended) {
            break;
        }
        pause(100).await;
    }
    let lent = a.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.state, lent.end_reason), (GrantState::Ended, Some(GrantEnd::Revoked)));
    let _ = Duration::from_secs(0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_a_pc_of_my_account_is_lent_to_and_one_that_loses_the_marker_loses_the_lend() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    a.wire.unmarked.store(true, Ordering::SeqCst);
    assert_eq!(a.lend.far_offer(B_HEX, "claude").unwrap_err(), "Only a PC signed in to your account can use your sign-ins.");
    a.wire.unmarked.store(false, Ordering::SeqCst);
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    let grant_id = ask(&b, &offer, offer.secs).await.unwrap();
    borrowed_up(&b, &grant_id).await;
    a.wire.unmarked.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        if a.lend.state(true).grants.iter().any(|g| g.id == grant_id && g.state == GrantState::Ended) {
            break;
        }
        pause(100).await;
    }
    assert_eq!(a.lend.state(true).grants.iter().find(|g| g.id == grant_id).unwrap().end_reason, Some(GrantEnd::Revoked));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_door_expects_items_only_around_a_promise_an_ask_or_a_running_lend() {
    let (a, b, _mem) = two();
    let _profile = my_pcs_profile(&a.lend);
    assert!(!a.lend.expecting_from(B_HEX) && !b.lend.expecting_from(A_HEX), "nothing is expected from a PC that never switched anything on");
    let offer = a.lend.far_offer(B_HEX, "claude").unwrap();
    assert!(a.lend.expecting_from(B_HEX), "the lender wrote a promise for that PC");
    assert!(!a.lend.expecting_from(&"cc".repeat(32)), "and only for that PC");
    let grant_id = ask(&b, &offer, offer.secs).await.unwrap();
    borrowed_up(&b, &grant_id).await;
    // The promise is used up, but the lend runs: a take-back or an Extend between the two still gets through.
    assert!(a.lend.expecting_from(B_HEX) && b.lend.expecting_from(A_HEX));
    a.lend.revoke(&grant_id).unwrap();
    assert!(!a.lend.expecting_from(B_HEX) && !b.lend.expecting_from(A_HEX), "over: the door shuts again");
}
