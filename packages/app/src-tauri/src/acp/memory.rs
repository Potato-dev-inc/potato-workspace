//! Memory guard for warm agents and standbys. A warm agent costs real memory (about 620 MB for a Claude helper, about
//! 885 MB for an OpenCode one), and a PC that runs out of commit memory crashes other programs. Warming checks free
//! memory first and waits when it is low. A chat the person starts is never blocked: it only gets a plain warning line.

/// What the PC has right now, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    /// Commit memory still available to this process (page file plus RAM).
    pub free_commit: u64,
    pub free_phys: u64,
    pub total_phys: u64,
}

/// Reads memory. A trait so the rules can be tested with a fake.
pub trait MemoryReader {
    fn read(&self) -> Option<MemInfo>;
}

/// The real PC. Off Windows it reads nothing (no guard).
pub struct SystemReader;

#[cfg(windows)]
impl MemoryReader for SystemReader {
    fn read(&self) -> Option<MemInfo> {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: a zeroed MEMORYSTATUSEX with its length set is what the call asks for.
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) == 0 {
                return None;
            }
            Some(MemInfo { free_commit: status.ullAvailPageFile, free_phys: status.ullAvailPhys, total_phys: status.ullTotalPhys })
        }
    }
}

#[cfg(not(windows))]
impl MemoryReader for SystemReader {
    fn read(&self) -> Option<MemInfo> {
        None
    }
}

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
/// Warming waits while free commit is below this.
pub const MIN_FREE_COMMIT: u64 = 3 * GB;

/// About what one warm helper of this agent holds (measured, PLAN-PERF 2b).
pub fn expected_bytes(agent: &str) -> u64 {
    let agent = agent.to_ascii_lowercase();
    if agent.contains("opencode") {
        885 * MB
    } else if agent.contains("claude") {
        620 * MB
    } else {
        700 * MB
    }
}

/// Free commit needed before warming `agent`: 3 GB, or 1.5 times its size when that is more.
pub fn needed_commit(agent: &str) -> u64 {
    MIN_FREE_COMMIT.max(expected_bytes(agent) * 3 / 2)
}

/// Whether memory is too low to warm `agent`. An unreadable PC is never low.
pub fn is_low(reader: &dyn MemoryReader, agent: &str) -> bool {
    reader.read().is_some_and(|info| info.free_commit < needed_commit(agent))
}

/// The warning for a chat the person starts, when memory is low. The chat starts anyway.
pub fn chat_warning(reader: &dyn MemoryReader, agent: &str) -> Option<String> {
    let info = reader.read()?;
    (info.free_commit < needed_commit(agent)).then(|| "This PC is low on memory. The chat may be slow. Closing other programs can help.".to_string())
}

/// The warm pool's default sizes for a PC with this much RAM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub total: usize,
    pub per_provider: u8,
}

/// Defaults by total RAM: under 16 GB, 3 in all and 2 per provider; 16 to 32 GB, 6 in all; above that, 10. `None` (unreadable):
/// today's 10.
pub fn default_caps(total_phys: Option<u64>) -> Caps {
    match total_phys {
        Some(b) if b < 16 * GB => Caps { total: 3, per_provider: 2 },
        Some(b) if b <= 32 * GB => Caps { total: 6, per_provider: 6 },
        _ => Caps { total: 10, per_provider: 10 },
    }
}

/// The defaults for this PC, read once.
pub fn pc_caps() -> Caps {
    static CAPS: once_cell::sync::Lazy<Caps> = once_cell::sync::Lazy::new(|| default_caps(SystemReader.read().map(|i| i.total_phys)));
    *CAPS
}

/// How long an unused warm agent or standby sits before it goes to sleep (its program is closed to give the memory back),
/// by total RAM: under 16 GB 5 minutes, 16 to 32 GB 10 minutes. `None`: this PC keeps today's values (a bigger PC, or an
/// unreadable one). The tiers match `default_caps`.
pub fn idle_tier_secs(total_phys: Option<u64>) -> Option<u64> {
    match total_phys {
        Some(b) if b < 16 * GB => Some(5 * 60),
        Some(b) if b <= 32 * GB => Some(10 * 60),
        _ => None,
    }
}

/// The idle time to use when the person set none: the RAM tier, but never longer than `today` (the old default).
pub fn default_idle_secs(total_phys: Option<u64>, today: u64) -> u64 {
    idle_tier_secs(total_phys).map_or(today, |tier| tier.min(today))
}

/// This PC's total RAM, read once.
pub fn pc_total_phys() -> Option<u64> {
    static TOTAL: once_cell::sync::Lazy<Option<u64>> = once_cell::sync::Lazy::new(|| SystemReader.read().map(|i| i.total_phys));
    *TOTAL
}

/// One log line when the warm loop starts.
pub fn log_start(reader: &dyn MemoryReader) {
    let info = reader.read();
    let caps = default_caps(info.map(|i| i.total_phys));
    tracing::info!(
        cap_total = caps.total,
        cap_per_provider = caps.per_provider,
        free_commit_mb = info.map(|i| i.free_commit / MB),
        free_phys_mb = info.map(|i| i.free_phys / MB),
        "acp: warm memory guard"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Option<MemInfo>);
    impl MemoryReader for Fake {
        fn read(&self) -> Option<MemInfo> {
            self.0
        }
    }
    fn commit(gb_tenths: u64) -> Fake {
        Fake(Some(MemInfo { free_commit: gb_tenths * GB / 10, free_phys: 8 * GB, total_phys: 16 * GB }))
    }

    #[test]
    fn warming_waits_below_three_gb_free_commit() {
        assert!(is_low(&commit(29), "claude"));
        assert!(!is_low(&commit(31), "claude"));
        assert!(!is_low(&Fake(None), "claude"));
    }

    #[test]
    fn a_big_agent_needs_one_and_a_half_times_its_size_when_that_is_more_than_three_gb() {
        assert_eq!(needed_commit("claude"), 3 * GB);
        assert_eq!(needed_commit("OpenCode"), 3 * GB);
        assert_eq!(needed_commit("claude-code") , 3 * GB);
    }

    #[test]
    fn a_chat_is_warned_never_blocked() {
        assert!(chat_warning(&commit(10), "claude").is_some());
        assert!(chat_warning(&commit(50), "claude").is_none());
        assert!(chat_warning(&Fake(None), "claude").is_none());
    }

    #[test]
    fn idle_time_follows_total_ram() {
        assert_eq!(idle_tier_secs(Some(8 * GB)), Some(300));
        assert_eq!(idle_tier_secs(Some(16 * GB)), Some(600));
        assert_eq!(idle_tier_secs(Some(32 * GB)), Some(600));
        assert_eq!(idle_tier_secs(Some(64 * GB)), None);
        assert_eq!(idle_tier_secs(None), None);
        assert_eq!(default_idle_secs(Some(8 * GB), 1200), 300);
        assert_eq!(default_idle_secs(Some(24 * GB), 1800), 600);
        assert_eq!(default_idle_secs(Some(64 * GB), 1200), 1200);
        // A tier never makes the time longer than today's value.
        assert_eq!(default_idle_secs(Some(24 * GB), 120), 120);
    }

    #[test]
    fn the_default_cap_follows_total_ram() {
        assert_eq!(default_caps(Some(8 * GB)), Caps { total: 3, per_provider: 2 });
        assert_eq!(default_caps(Some(16 * GB)).total, 6);
        assert_eq!(default_caps(Some(32 * GB)).total, 6);
        assert_eq!(default_caps(Some(64 * GB)), Caps { total: 10, per_provider: 10 });
        assert_eq!(default_caps(None).total, 10);
    }
}
