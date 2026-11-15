//! Who sent this request, as a device identity id (`device_identity`): the paired phone whose token it carries, the
//! paired PC whose link it came over, or `None` for this PC (the app and its own tools). Read from the token and the
//! link's own door only, never from a header a caller could write.

use super::Ctx;

pub(crate) fn sender_of(cx: &Ctx) -> Option<String> {
    sender_of_parts(cx.session, cx.headers)
}

/// `sender_of` without the request context (the tests call it with a session and headers).
pub(crate) fn sender_of_parts(session: Option<&str>, headers: &str) -> Option<String> {
    // An agent's MCP session is not a device.
    if session.is_some() {
        return None;
    }
    if let Some(node) = crate::bridge::link_current_node() {
        return Some(crate::mobile_pairing::link_device_id(&node));
    }
    let token = crate::mobile_pairing::bearer_token(headers)?;
    crate::mobile_pairing::pairing_store()?.lock().device_id_for_token(&token)
}

#[cfg(test)]
#[path = "sender_tests.rs"]
mod tests;
