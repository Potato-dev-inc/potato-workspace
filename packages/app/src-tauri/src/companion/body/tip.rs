//! The tip: one short block of body state for the companion (ported from fishd's "tip" layer).
//!
//! For a companion that lives in an agent pane it is added to the brief at each start and to
//! check-in messages, never to the instruction file on every turn. It says what the companion feels as
//! effects, not as numbers, and it never holds anything from the person's notes.

use super::{drives, mood, presence, selfstate, BodyState};

/// Longest tip, in characters. It sits at the end of a message, so it stays small.
pub const TIP_CAP: usize = 600;

/// The tip, or an empty string when there is nothing to say. `sleeping` is the keeper's flag.
pub fn render(body: &BodyState, now_ms: i64, offset: i32, sleeping: bool) -> String {
    let mut lines: Vec<String> = vec![mood::render(&body.mood, now_ms, offset)];
    let me = selfstate::render(&body.me, now_ms, sleeping);
    if !me.is_empty() {
        lines.push(format!("Inside: {me}."));
    }
    let drive_line = drives::render(&body.drives, &body.rules);
    if !drive_line.is_empty() {
        lines.push(format!("Drives: {drive_line}."));
    }
    if !body.drives.pending_wake.is_empty() {
        lines.push(format!("Building up: {}.", body.drives.pending_wake.join(", ")));
    }
    let away = presence::render(body.offline.as_ref(), now_ms, offset);
    if !away.is_empty() {
        lines.push(away);
    }
    if !body.pace_hint.is_empty() {
        lines.push(body.pace_hint.clone());
    }
    let text = lines.join("\n");
    text.chars().take(TIP_CAP).collect()
}

/// The tip as a block at the end of a message (a blank line, then the block), or nothing.
pub fn appended(body: &BodyState, now_ms: i64, offset: i32, sleeping: bool) -> String {
    let tip = render(body, now_ms, offset, sleeping);
    if tip.is_empty() {
        String::new()
    } else {
        format!("\n\n(How you feel right now, from Potato Workspace. Let it colour your tone; do not mention it unless asked.)\n{tip}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> BodyState {
        let d = std::env::temp_dir().join(format!("pm-tip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        BodyState::open(&d, 0)
    }

    #[test]
    fn the_tip_has_the_mood_and_the_drives_and_stays_short() {
        let tip = render(&body(), 9 * 3_600_000, 0, false);
        assert!(tip.contains("You feel genki"), "{tip}");
        assert!(tip.contains("Drives: Missing you 0/80"), "{tip}");
        assert!(tip.chars().count() <= TIP_CAP);
    }

    #[test]
    fn a_waiting_drive_and_a_gap_are_named() {
        let mut b = body();
        b.drives.pending_wake.push("Missing you".into());
        b.offline = Some(presence::Offline { from_ms: 0, to_ms: 3_600_000, minutes: 60, clean: true });
        let tip = render(&b, 3_600_000, 0, false);
        assert!(tip.contains("Building up: Missing you"), "{tip}");
        assert!(tip.contains("You were away"), "{tip}");
    }

    #[test]
    fn it_is_cut_at_the_cap() {
        let mut b = body();
        b.pace_hint = "x".repeat(2_000);
        assert_eq!(render(&b, 0, 0, false).chars().count(), TIP_CAP);
    }

    #[test]
    fn the_appended_block_says_it_is_for_tone_only() {
        let text = appended(&body(), 0, 0, false);
        assert!(text.starts_with("\n\n(How you feel"), "{text}");
        assert!(text.contains("do not mention it"));
    }
}
