//! Who and where the bot listens: the hard boundary, applied to every message before the journal, the gate or
//! the brain. Default-deny (fishd's `onlyChannels` empty = everywhere is NOT kept): a server or channel that is
//! not on the person's list is dropped.

use super::config::{BotSettings, Dms};

/// A message from Discord, reduced to what the bot uses. Every text in it is untrusted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Incoming {
    pub id: String,
    pub channel_id: String,
    /// `None` for a direct message.
    pub guild_id: Option<String>,
    pub author_id: String,
    /// Already cleaned to one short line.
    pub author_name: String,
    pub author_is_bot: bool,
    pub content: String,
    /// Everybody mentioned: id and display name.
    pub mentions: Vec<(String, String)>,
    /// The author of the message this one replies to.
    pub reply_to_author: Option<String>,
}

/// Why a message was dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deny {
    /// The bot is switched off.
    Off,
    /// Written by a bot, or by this bot itself.
    Bot,
    /// Not on the allow list (an empty list allows nothing).
    NotListed,
    DmsOff,
    /// A direct message from somebody who is not an owner.
    DmNotOwner,
}

/// What a message that passed is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Allowed {
    pub dm: bool,
    pub owner: bool,
    /// The server lets it join in without being called.
    pub ambient: bool,
}

pub fn check(settings: &BotSettings, me_id: &str, m: &Incoming) -> Result<Allowed, Deny> {
    if !settings.on {
        return Err(Deny::Off);
    }
    if m.author_is_bot || m.author_id == me_id {
        return Err(Deny::Bot);
    }
    let owner = settings.owners.iter().any(|o| *o == m.author_id);
    match &m.guild_id {
        None => {
            if settings.dms == Dms::Off {
                return Err(Deny::DmsOff);
            }
            if !owner {
                return Err(Deny::DmNotOwner);
            }
            Ok(Allowed { dm: true, owner: true, ambient: false })
        }
        Some(guild) => {
            let entry = settings.allow.iter().find(|a| a.guild_id == *guild).ok_or(Deny::NotListed)?;
            if !entry.channels.iter().any(|c| *c == m.channel_id) {
                return Err(Deny::NotListed);
            }
            Ok(Allowed { dm: false, owner, ambient: entry.ambient })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discord_bot::config::Allow;

    const G: &str = "111111111111111111";
    const C: &str = "222222222222222222";
    const OWNER: &str = "333333333333333333";
    const ME: &str = "900000000000000001";

    fn settings() -> BotSettings {
        BotSettings {
            on: true,
            allow: vec![Allow { guild_id: G.into(), channels: vec![C.into()], ambient: false }],
            owners: vec![OWNER.into()],
            ..Default::default()
        }
    }

    fn msg(guild: Option<&str>, channel: &str, author: &str) -> Incoming {
        Incoming { id: "1".into(), channel_id: channel.into(), guild_id: guild.map(String::from), author_id: author.into(), content: "hello".into(), ..Default::default() }
    }

    #[test]
    fn an_empty_allow_list_answers_nowhere() {
        let mut s = settings();
        s.allow.clear();
        assert_eq!(check(&s, ME, &msg(Some(G), C, "5")), Err(Deny::NotListed));
        assert_eq!(check(&s, ME, &msg(Some(G), C, OWNER)), Err(Deny::NotListed), "not even the owner in a server");
    }

    #[test]
    fn only_the_listed_server_and_channel_pass() {
        let s = settings();
        assert_eq!(check(&s, ME, &msg(Some(G), C, "5")), Ok(Allowed { dm: false, owner: false, ambient: false }));
        assert_eq!(check(&s, ME, &msg(Some(G), "444444444444444444", "5")), Err(Deny::NotListed));
        assert_eq!(check(&s, ME, &msg(Some("555555555555555555"), C, "5")), Err(Deny::NotListed));
        assert_eq!(check(&s, ME, &msg(Some(G), C, OWNER)).unwrap().owner, true);
    }

    #[test]
    fn ambient_comes_from_the_listed_server_only() {
        let mut s = settings();
        s.allow[0].ambient = true;
        assert!(check(&s, ME, &msg(Some(G), C, "5")).unwrap().ambient);
    }

    #[test]
    fn bots_and_itself_are_ignored() {
        let s = settings();
        let mut bot = msg(Some(G), C, "5");
        bot.author_is_bot = true;
        assert_eq!(check(&s, ME, &bot), Err(Deny::Bot));
        assert_eq!(check(&s, ME, &msg(Some(G), C, ME)), Err(Deny::Bot));
    }

    #[test]
    fn a_direct_message_needs_an_owner_and_dms_on() {
        let mut s = settings();
        assert_eq!(check(&s, ME, &msg(None, "9", "5")), Err(Deny::DmNotOwner));
        assert_eq!(check(&s, ME, &msg(None, "9", OWNER)), Ok(Allowed { dm: true, owner: true, ambient: false }));
        s.dms = Dms::Off;
        assert_eq!(check(&s, ME, &msg(None, "9", OWNER)), Err(Deny::DmsOff));
        s.dms = Dms::Owners;
        s.owners.clear();
        assert_eq!(check(&s, ME, &msg(None, "9", OWNER)), Err(Deny::DmNotOwner));
    }

    #[test]
    fn off_drops_everything() {
        let mut s = settings();
        s.on = false;
        assert_eq!(check(&s, ME, &msg(Some(G), C, "5")), Err(Deny::Off));
        assert_eq!(check(&s, ME, &msg(None, "9", OWNER)), Err(Deny::Off));
    }
}
