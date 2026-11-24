//! The window-free part of the PC link: the server side of `pm/agents/1` (`serve`), its wire, the route and activity logs,
//! the web grant, and the PC link's rights code (`pclink`). The app's `device_link` re-exports these under their old names.

pub mod activity;
pub mod files;
pub mod pclink;
pub mod route;
pub mod serve;
pub mod web;
pub mod wire;
