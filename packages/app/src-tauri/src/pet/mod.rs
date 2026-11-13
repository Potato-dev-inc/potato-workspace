//! Desktop Potato (Labs `desktop_pet_enabled`, off by default): a small Potato in its own transparent window on the
//! desktop. It sleeps, waves when an agent needs the person, and a click opens that agent.
//!
//! The rules live here and are unit tested without a window: what the window is made of (`window_spec`), when it
//! may exist at all (`plan`), how big it is, and where it sits (`place`). The window code is `runtime`, and it is
//! only reached through `plan`, so with the switch off (and in every test) no window is ever created.

mod place;
mod runtime;

use serde_json::Value;

pub use place::{anchored_resize, clamp, default_position, monitor_key, Rect, Saved};
pub use runtime::{apply_settings, fullscreen_busy, init, move_by, set_expanded};

pub const LABEL: &str = "pet";
pub const URL: &str = "index.html?pet=1";
pub const TITLE: &str = "Desktop Potato";
/// Gap between the window and the edges of the work area (logical px).
pub const EDGE_MARGIN: f64 = 12.0;
/// Space the speech bubble and the menu need above the sprite when the window is expanded (logical px).
pub const BUBBLE_ROOM: f64 = 124.0;
/// The expanded window is at least this wide (logical px).
pub const EXPANDED_MIN_WIDTH: f64 = 264.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PetSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl PetSize {
    pub fn parse(text: &str) -> Self {
        match text {
            "small" => Self::Small,
            "large" => Self::Large,
            _ => Self::Medium,
        }
    }

    /// Side of the sprite in logical px.
    pub fn sprite_px(self) -> f64 {
        match self {
            Self::Small => 96.0,
            Self::Medium => 128.0,
            Self::Large => 160.0,
        }
    }
}

/// The pet's settings, read from the effective public settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PetSettings {
    pub enabled: bool,
    pub size: PetSize,
    /// Epoch ms until which the person hid the pet ("Hide for 1 hour"); 0 = not hidden.
    pub hidden_until_ms: u64,
}

impl PetSettings {
    pub fn from_settings(public: &Value) -> Self {
        Self {
            enabled: public.get("desktop_pet_enabled").and_then(Value::as_bool).unwrap_or(false),
            size: PetSize::parse(public.get("desktop_pet_size").and_then(Value::as_str).unwrap_or("medium")),
            hidden_until_ms: public.get("desktop_pet_hidden_until_ms").and_then(Value::as_u64).unwrap_or(0),
        }
    }

    /// Whether the window should be on screen at `now_ms`.
    pub fn visible_at(&self, now_ms: u64) -> bool {
        self.enabled && self.hidden_until_ms <= now_ms
    }
}

/// Window size (logical px) with nothing but the sprite: about 140 x 160 for the medium size.
pub fn compact_size(size: PetSize) -> (f64, f64) {
    let s = size.sprite_px();
    (s + 12.0, s + 32.0)
}

/// Window size while a bubble or the menu is open: the compact size plus room above, and wide enough for the text.
pub fn expanded_size(size: PetSize) -> (f64, f64) {
    let (w, h) = compact_size(size);
    (w.max(EXPANDED_MIN_WIDTH), h + BUBBLE_ROOM)
}

/// Everything the window is built with. Tested field by field: the pet must be transparent, frameless, always on top,
/// out of the taskbar, and must never take or accept focus (so it cannot steal it from the person's app).
#[derive(Debug, Clone, PartialEq)]
pub struct WindowSpec {
    pub label: &'static str,
    pub url: &'static str,
    pub title: &'static str,
    pub width: f64,
    pub height: f64,
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub resizable: bool,
    pub shadow: bool,
    /// Whether the window takes focus when it appears.
    pub focused: bool,
    /// Whether the window can ever be activated.
    pub focusable: bool,
    /// Shown right after it is built (false: the runtime places it first, then shows it without activating).
    pub visible: bool,
}

pub fn window_spec(size: PetSize) -> WindowSpec {
    let (width, height) = compact_size(size);
    WindowSpec {
        label: LABEL,
        url: URL,
        title: TITLE,
        width,
        height,
        transparent: true,
        decorations: false,
        always_on_top: true,
        skip_taskbar: true,
        resizable: false,
        shadow: false,
        focused: false,
        focusable: false,
        visible: false,
    }
}

/// What a settings change does to the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Switch off, hidden for now, or never on: no window must exist (and none is built).
    Close,
    /// Build the window (it does not exist yet).
    Create,
    /// It exists: follow the size.
    Resize,
}

pub fn plan(settings: &PetSettings, now_ms: u64, window_exists: bool) -> Plan {
    if !settings.visible_at(now_ms) {
        Plan::Close
    } else if window_exists {
        Plan::Resize
    } else {
        Plan::Create
    }
}

/// Milliseconds from `now_ms` until a "hide for a while" ends (None when the pet is not hidden).
pub fn hidden_for_ms(settings: &PetSettings, now_ms: u64) -> Option<u64> {
    (settings.enabled && settings.hidden_until_ms > now_ms).then(|| settings.hidden_until_ms - now_ms)
}

/// Windows' `QUERY_USER_NOTIFICATION_STATE`: 2 busy (a full-screen app), 3 Direct3D full screen, 4 presentation mode.
pub fn fullscreen_from_notification_state(state: i32) -> bool {
    matches!(state, 2..=4)
}

#[cfg(test)]
mod tests;
