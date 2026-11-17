//! The agent browser (Labs `agent_browser_enabled`, N5-23): agents open, read and click the pages of the app they
//! are building, in a window the person can see and take over.
//!
//! Decisions (design: `AI-BROWSER-1114.md`, plan N5-23):
//! 1. **Engine:** the WebView2 that Potato Workspace already ships (0 MB extra). DevTools calls run *inside the
//!    process* (`cdp.rs`); no debugging port is opened.
//! 2. **One window with Point and Fix:** the browser uses the Point and Fix preview window (`point::window`). Point is
//!    a button in it, the agent bar is the second script in it.
//! 3. **Read as text, act by ref** (`tree.rs`, `page.rs`): the agent reads a short list ("e4 button Save") and says
//!    "click e4". Pictures are not part of P1.
//! 4. **Localhost only** (`guard.rs`): this computer's pages, never the app's own ports. No sign-ins, no outside
//!    sites in P0/P1. An agent never types into a password, card or code box.
//! 5. **The person is in charge** (`driver.rs`, `bar.rs`): an orange bar says who is using the page, with Take over
//!    and Stop. A click or key press by the person pauses the agent. Every step is in the audit log.
//! 6. **Same tools for every agent** (`tools.rs`, bridge route `browser_mcp.rs`, catalog `catalog/browser.rs`).
//! 7. **Page words are data** (`guard::untrusted`): what a page says is wrapped and marked, never obeyed.
//! 8. **Check it** (R4-11, `tab::Tab::check`, `live::check_it`, command `browser_check_it`): a button next to a pane's
//!    Preview opens the page, reads the console and the network, takes a picture and answers pass, fail or sign-in.
//!    The card is in the pane's Chat tab (frontend `CheckCard`). No new agent tool: an agent gets the same facts from
//!    `browser_open` (`console_problems`) and `browser_console`.
//! 9. **You sign in, the agent continues** (R4-12, `driver::Phase::SignIn`): when the page in front shows a password
//!    box, the agent stops (`SIGN_IN_WAITING`), the bar says "Sign in here, then press Continue" and the person signs
//!    in. The agent never sees what is typed and its tools refuse password boxes anyway (`guard`). Continue gives the
//!    page back; the same page does not stop the agent a second time.

pub mod bar;
pub mod chrome;
pub mod cdp;
pub mod console;
pub mod dock;
pub mod driver;
pub mod guard;
pub mod live;
pub mod page;
pub mod start;
pub mod tab;
pub mod tree;
