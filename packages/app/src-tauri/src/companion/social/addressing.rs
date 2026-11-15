//! Who a line is for. "Answer when called" must not mean "answer lines meant for somebody else": a mention of
//! another person, with no mention or name for the companion, is a conversation it is not in. (fishd
//! `addressing.ts`.)

/// True when the line is plainly aimed at someone else.
///
/// - `me_id`: the bot's own user id.
/// - `mentioned_ids`: everybody mentioned in the line, including the person a reply points at.
/// - `text`: the text.
/// - `names`: what people call the companion.
pub fn aimed_elsewhere(me_id: &str, mentioned_ids: &[String], text: &str, names: &[String]) -> bool {
    let others = mentioned_ids.iter().filter(|id| id.as_str() != me_id).count();
    if others == 0 {
        return false;
    }
    // Its own id among the mentions means it was called too.
    if mentioned_ids.iter().any(|id| id == me_id) {
        return false;
    }
    let lower = text.to_lowercase();
    !names.iter().any(|n| !n.is_empty() && lower.contains(&n.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_mention_of_someone_else_alone_is_not_for_it() {
        assert!(aimed_elsewhere("me", &ids(&["sam"]), "@Sam did you see this", &ids(&["mochi"])));
    }

    #[test]
    fn no_mentions_or_its_own_mention_or_its_name_means_it_may_be_for_it() {
        assert!(!aimed_elsewhere("me", &[], "hello all", &ids(&["mochi"])));
        assert!(!aimed_elsewhere("me", &ids(&["sam", "me"]), "@Sam @Mochi look", &ids(&["mochi"])));
        assert!(!aimed_elsewhere("me", &ids(&["sam"]), "@Sam and Mochi, look", &ids(&["mochi"])));
        assert!(aimed_elsewhere("me", &ids(&["sam"]), "@Sam look", &ids(&[""])));
    }
}
