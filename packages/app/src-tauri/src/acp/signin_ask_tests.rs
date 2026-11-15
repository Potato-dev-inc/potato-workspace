use super::*;

#[test]
fn a_menu_a_code_line_and_a_yes_no_are_questions() {
    for screen in [
        "Welcome to the agent\n\nSelect login method:\n\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account\n",
        "Browser didn't open? Use the url below to sign in\n\nhttps://example.com/oauth/authorize?code=true\n\nPaste code here if prompted >",
        "Trust the files in this folder? (y/n)",
        "Press Enter to continue",
        "Which account do you want to use?",
        "Enter your code:",
    ] {
        assert!(asks_the_person(screen), "{screen}");
    }
}

#[test]
fn a_screen_that_only_waits_for_the_browser_is_not_a_question() {
    for screen in [
        "Opening your browser to sign in...\n\nWaiting for you to finish in the browser.",
        "Starting sign-in\nLogged in as someone",
        "",
    ] {
        assert!(!asks_the_person(screen), "{screen}");
    }
}

#[test]
fn only_the_end_of_the_screen_counts() {
    let mut screen = String::from("Select login method:\n 1. One\n 2. Two\n");
    for n in 0..20 {
        screen.push_str(&format!("progress line {n}\n"));
    }
    screen.push_str("Waiting for the browser.\n");
    assert!(!asks_the_person(&screen), "an old menu far above the end is not a question now");
}
