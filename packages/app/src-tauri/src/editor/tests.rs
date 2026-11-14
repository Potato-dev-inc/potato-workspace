use super::*;

struct Tmp(PathBuf);
impl Tmp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("pm-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn touch(&self, rel: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "x").unwrap();
        p
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn places(t: &Tmp) -> Places {
    Places { path: OsString::new(), local_app_data: Some(t.0.join("local")), program_files: vec![t.0.join("pf")] }
}

#[test]
fn it_finds_only_the_editors_that_are_installed() {
    let t = Tmp::new();
    assert!(find_editors(&places(&t)).is_empty());
    t.touch("local/Programs/Microsoft VS Code/Code.exe");
    t.touch("local/Programs/Zed/Zed.exe");
    t.touch("pf/Notepad++/notepad++.exe");
    let ids: Vec<String> = find_editors(&places(&t)).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["vscode", "zed", "notepadpp"]);
}

#[test]
fn it_builds_each_editors_line_syntax() {
    let file = Path::new("C:/p/src/a.ts");
    assert_eq!(args_for(Line::Goto, file, Some(12)), vec![OsString::from("--goto"), OsString::from("C:/p/src/a.ts:12")]);
    assert_eq!(args_for(Line::Colon, file, Some(3)), vec![OsString::from("C:/p/src/a.ts:3")]);
    assert_eq!(args_for(Line::NFlag, file, Some(7)), vec![OsString::from("-n7"), OsString::from("C:/p/src/a.ts")]);
    // No line, or line 0: just the file.
    assert_eq!(args_for(Line::Goto, file, None), vec![OsString::from("C:/p/src/a.ts")]);
    assert_eq!(args_for(Line::Colon, file, Some(0)), vec![OsString::from("C:/p/src/a.ts")]);
    // A Windows verbatim prefix is dropped.
    assert_eq!(args_for(Line::Colon, Path::new(r"\\?\C:\p\a.ts"), None), vec![OsString::from(r"C:\p\a.ts")]);
}

#[test]
fn it_runs_only_the_program_it_found_for_a_known_id() {
    let t = Tmp::new();
    let exe = t.touch("local/Programs/cursor/Cursor.exe");
    let (program, args) = plan(&places(&t), "cursor", Path::new("C:/p/a.ts"), Some(2)).unwrap();
    assert_eq!(program, exe);
    assert_eq!(args.len(), 2);
    // An id that is a path or a command is not an editor.
    assert!(plan(&places(&t), "C:/Windows/System32/cmd.exe", Path::new("a"), None).unwrap_err().starts_with("EDITOR_UNKNOWN"));
    assert!(plan(&places(&t), "cmd", Path::new("a"), None).unwrap_err().starts_with("EDITOR_UNKNOWN"));
    // A known editor that is not installed.
    assert!(plan(&places(&t), "zed", Path::new("a"), None).unwrap_err().starts_with("EDITOR_MISSING"));
}

#[test]
fn it_refuses_a_file_outside_the_project_folder() {
    let t = Tmp::new();
    let root = t.0.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let outside = t.touch("secret.txt");
    let root = root.to_string_lossy().to_string();
    assert!(open(&root, "../secret.txt", "vscode", None).unwrap_err().starts_with("FILES_OUTSIDE"));
    assert!(open(&root, &outside.to_string_lossy(), "vscode", None).unwrap_err().starts_with("FILES_OUTSIDE"));
}
