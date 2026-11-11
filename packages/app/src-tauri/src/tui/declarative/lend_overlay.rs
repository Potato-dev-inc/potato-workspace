//! The trusted lend specs of declarative agents: `lend-specs.toml` is compiled into the app, so it is trusted; nothing
//! reads it from a user, project or store folder (a definition could otherwise aim the lender's key at another host).
//! An agent id is looked up here only when its profile asks. No agent is named in code.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;

use crate::capacity_proxy::spec::ProxySpec;

const OVERLAY: &str = include_str!("lend-specs.toml");

/// Every entry of an overlay text, each checked like any spec. Fails on the first bad entry.
pub fn parse(text: &str) -> Result<BTreeMap<String, ProxySpec>, String> {
    let mut map: BTreeMap<String, ProxySpec> = toml::from_str(text).map_err(|e| format!("lend specs: {e}"))?;
    for (id, spec) in map.iter_mut() {
        spec.agent_id = id.clone();
        spec.validate().map_err(|e| format!("{id}: {e}"))?;
    }
    Ok(map)
}

static SPECS: Lazy<Result<BTreeMap<String, ProxySpec>, String>> = Lazy::new(|| parse(OVERLAY));

/// The spec for agent `id`, or `None` when the table has none. A table that does not parse refuses every entry.
pub fn spec_for(id: &str) -> Option<Result<ProxySpec, String>> {
    match &*SPECS {
        Ok(map) => map.get(id).cloned().map(Ok),
        Err(why) if OVERLAY.contains(&format!("[{id}]")) => Some(Err(why.clone())),
        Err(_) => None,
    }
}

pub fn ids() -> Vec<String> {
    SPECS.as_ref().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_and_names_gemini_with_a_key_only() {
        let map = parse(OVERLAY).unwrap();
        let gemini = &map["gemini"];
        assert_eq!(gemini.agent_id, "gemini");
        assert_eq!(gemini.upstream, "https://generativelanguage.googleapis.com");
        assert!(gemini.auth.api_key.is_some() && gemini.auth.account.is_none());
        assert!(gemini.auth.account_not_yet.as_deref().unwrap().contains("not supported yet"));
        assert!(gemini.chat.is_none());
        assert_eq!(ids(), vec!["gemini".to_string()]);
    }

    #[test]
    fn a_bad_entry_refuses_the_table() {
        assert!(parse("[x]\nsupport = \"lab\"\nshape = \"s\"\nupstream = \"http://nope\"\npaths = [\"POST /a\"]\n[x.auth.api_key]\nheader = \"h\"\n[x.hookup]\n").is_err());
    }
}
