//! Two quick resizes of one pane must both be applied, in order, and the answer of each must tell
//! the truth about what it did. Also: a write's typing-permit check must not hold the registry.

use super::*;

/// A PTY whose resize takes a while (ConPTY can block) and remembers every size it was given.
struct SlowMaster {
    sizes: Arc<Mutex<Vec<(u16, u16)>>>,
}

impl MasterPty for SlowMaster {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        thread::sleep(Duration::from_millis(200));
        self.sizes.lock().push((size.cols, size.rows));
        Ok(())
    }
    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        Ok(PtySize { rows: 3, cols: 10, pixel_width: 0, pixel_height: 0 })
    }
    fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, anyhow::Error> {
        anyhow::bail!("not used")
    }
    fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, anyhow::Error> {
        anyhow::bail!("not used")
    }
    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<i32> {
        None
    }
    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<portable_pty::unix::RawFd> {
        None
    }
}

#[test]
fn a_second_resize_back_to_the_old_size_is_not_swallowed_by_the_first() {
    let id = "resize-race-back-and-forth";
    let mut cmd = CommandBuilder::new(if cfg!(windows) { "ping" } else { "sh" });
    if cfg!(windows) {
        cmd.args(["-n", "60", "127.0.0.1"]);
    } else {
        cmd.args(["-c", "sleep 60"]);
    }
    let pane = PaneRegistry::test_pane_running(id, cmd);
    let sizes = Arc::new(Mutex::new(Vec::new()));
    *pane.master.lock() = Box::new(SlowMaster { sizes: sizes.clone() });
    let registry = Arc::new(Mutex::new(PaneRegistry::default()));
    registry.lock().panes.insert(id.into(), pane);
    crate::flight::start(id, 10, 3);

    // The pane is 10x3. First 40x12 (slow), then, while that is still in flight, back to 10x3.
    let first = {
        let registry = registry.clone();
        thread::spawn(move || resize(&registry, id, 40, 12))
    };
    thread::sleep(Duration::from_millis(60));
    let second = resize(&registry, id, 10, 3);
    assert_eq!(first.join().unwrap(), Ok(true));
    assert_eq!(second, Ok(true), "the PTY was at 40x12 when this arrived: it is a real change");
    assert_eq!(*sizes.lock(), vec![(40, 12), (10, 3)], "the PTY must end at the last size asked for");
    let info = registry.lock().panes.get(id).map(|pane| (pane.info.cols, pane.info.rows));
    assert_eq!(info, Some((10, 3)));
    kill_pane_and_wait(&registry, id, Some("test")).unwrap();
}

#[test]
fn a_write_does_not_hold_the_registry_while_it_checks_the_process() {
    let src = include_str!("pane_io.rs");
    let body = src.split("pub(crate) fn recorded_input").next().unwrap();
    assert!(!body.contains("drop(reg)"), "write_input must not keep the registry guard alive");
    let first_lock = body.find("registry.lock()").expect("write_input reads the registry");
    let permit = body.find("admit_terminal_write").expect("write_input checks the permit");
    assert!(first_lock < permit);
    // The guard lives in its own block that ends before the permit check.
    let between = &body[first_lock..permit];
    assert!(between.contains("};"), "the registry guard must be released before the permit check");
}
