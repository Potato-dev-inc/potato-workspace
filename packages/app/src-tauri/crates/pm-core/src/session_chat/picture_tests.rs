use super::*;

/// The 8 bytes every png starts with, then filler: enough for the signature check.
fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.extend_from_slice(&[0u8; 32]);
    bytes
}

struct Dirs {
    project: PathBuf,
    outside: PathBuf,
}

fn dirs() -> Dirs {
    let base = std::env::temp_dir().join(format!("pm-picture-{}", uuid::Uuid::new_v4()));
    let project = base.join("project");
    let outside = base.join("outside");
    std::fs::create_dir_all(project.join("out")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    Dirs { project, outside }
}

fn cwd(d: &Dirs) -> String {
    d.project.to_string_lossy().into_owned()
}

fn roots(d: &Dirs) -> Vec<PathBuf> {
    vec![d.project.clone()]
}

fn code(result: Result<Picture, Refused>) -> &'static str {
    result.err().expect("refused").code
}

#[test]
fn a_picture_in_the_project_is_read_by_a_relative_or_an_absolute_path() {
    let d = dirs();
    std::fs::write(d.project.join("out").join("chart.png"), png_bytes()).unwrap();
    let relative = read("out/chart.png", &cwd(&d), &roots(&d), MAX_BYTES).unwrap();
    assert_eq!(relative.mime, "image/png");
    assert_eq!(relative.name, "chart.png");
    assert!(relative.data_url.starts_with("data:image/png;base64,"));
    let absolute = read(&d.project.join("out").join("chart.png").to_string_lossy(), &cwd(&d), &roots(&d), MAX_BYTES).unwrap();
    assert_eq!(absolute.data_url, relative.data_url);
}

#[test]
fn a_file_address_of_a_picture_in_the_project_works() {
    let d = dirs();
    let file = d.project.join("shot one.png");
    std::fs::write(&file, png_bytes()).unwrap();
    let slashes = file.to_string_lossy().replace('\\', "/");
    let address = format!("file:///{}", slashes.trim_start_matches('/').replace(' ', "%20"));
    assert!(read(&address, &cwd(&d), &roots(&d), MAX_BYTES).is_ok(), "{address}");
}

#[test]
fn a_picture_outside_the_project_is_refused_by_every_way_of_naming_it() {
    let d = dirs();
    std::fs::write(d.outside.join("secret.png"), png_bytes()).unwrap();
    // Absolute.
    assert_eq!(code(read(&d.outside.join("secret.png").to_string_lossy(), &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    // Up and out with `..`.
    assert_eq!(code(read("../outside/secret.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    assert_eq!(code(read("out/../../outside/secret.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    // The same answer as for a file that does not exist, so nothing is learned about the PC.
    assert_eq!(code(read("nothing-here.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
}

#[test]
fn a_link_that_points_out_of_the_project_is_refused() {
    let d = dirs();
    std::fs::write(d.outside.join("secret.png"), png_bytes()).unwrap();
    let link = d.project.join("link.png");
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(d.outside.join("secret.png"), &link).is_ok();
    #[cfg(not(windows))]
    let made = std::os::unix::fs::symlink(d.outside.join("secret.png"), &link).is_ok();
    if !made {
        // Making a link needs a right this account may not have; the `..` and absolute cases above still ran.
        return;
    }
    assert_eq!(code(read("link.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
}

#[test]
fn a_web_address_is_never_fetched() {
    let d = dirs();
    for address in ["http://example.com/a.png", "https://example.com/a.png", "//example.com/a.png", "data:image/png;base64,AAAA", "\\\\server\\share\\a.png", "javascript:alert(1)", "ftp://x/a.png"] {
        assert_eq!(code(read(address, &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT", "{address}");
    }
    assert_eq!(code(read("", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    assert_eq!(code(read("a\0.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
}

#[test]
fn only_pictures_whose_bytes_match_their_name_are_shown() {
    let d = dirs();
    std::fs::write(d.project.join("notes.txt"), "hello").unwrap();
    std::fs::write(d.project.join("fake.png"), "this is not a png").unwrap();
    std::fs::write(d.project.join(".env"), "KEY=value").unwrap();
    assert_eq!(code(read("notes.txt", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_BAD_TYPE");
    assert_eq!(code(read("fake.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_BAD_TYPE");
    assert_eq!(code(read(".env", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_BAD_TYPE");
    assert_eq!(code(read("out", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_BAD_TYPE");
}

#[test]
fn a_big_picture_is_refused_and_the_phone_cap_is_lower() {
    let d = dirs();
    let mut big = png_bytes();
    big.resize(4 * 1024 * 1024, 0);
    std::fs::write(d.project.join("big.png"), &big).unwrap();
    assert!(read("big.png", &cwd(&d), &roots(&d), MAX_BYTES).is_ok());
    assert_eq!(code(read("big.png", &cwd(&d), &roots(&d), PHONE_MAX_BYTES)), "PICTURE_TOO_BIG");
}

#[test]
fn a_plain_svg_is_shown_and_an_svg_that_could_run_something_is_not() {
    let d = dirs();
    let plain = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/><use href="#a"/></svg>"##;
    std::fs::write(d.project.join("ok.svg"), plain).unwrap();
    assert_eq!(read("ok.svg", &cwd(&d), &roots(&d), MAX_BYTES).unwrap().mime, "image/svg+xml");
    let bad = [
        r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg"><rect onclick = "x()"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="x"/></foreignObject></svg>"#,
        r#"<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://evil.example/a.css);</style></svg>"#,
        r#"<SVG xmlns="http://www.w3.org/2000/svg"><SCRIPT>1</SCRIPT></SVG>"#,
    ];
    for (n, text) in bad.iter().enumerate() {
        let name = format!("bad{n}.svg");
        std::fs::write(d.project.join(&name), text).unwrap();
        assert_eq!(code(read(&name, &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_UNSAFE", "{text}");
    }
}

#[test]
fn a_word_that_only_looks_like_a_handler_does_not_block_a_drawing() {
    // "tension", "bottom", a text node with "on" inside: none is an attribute.
    assert!(!svg_is_unsafe(br#"<svg><text x="1" y="2">Month on month = growth</text><rect id="bottom"/></svg>"#));
}

#[test]
fn the_uploads_folder_is_a_second_allowed_folder() {
    let d = dirs();
    std::fs::write(d.outside.join("from-phone.png"), png_bytes()).unwrap();
    let roots = vec![d.project.clone(), d.outside.clone()];
    assert!(read(&d.outside.join("from-phone.png").to_string_lossy(), &cwd(&d), &roots, MAX_BYTES).is_ok());
}

#[test]
fn the_real_roots_are_the_project_and_the_phone_uploads() {
    let r = roots_for("C:/work/app");
    assert_eq!(r.len(), 2);
    assert!(r[1].ends_with("phone-uploads"));
}

#[test]
fn a_network_share_is_refused_in_every_spelling_before_the_disk_is_asked() {
    let d = dirs();
    for text in [
        "file:%5C%5Chost%5Cshare%5Cx.png",
        "file:%5c%5chost%5cshare%5cx.png",
        "file://host/share/x.png",
        "file:////host/share/x.png",
        "//host/share/x.png",
        r"\\host\share\x.png",
        "%5C%5Chost%5Cshare%5Cx.png",
        "%2F%2Fhost/share/x.png",
        r"\\?\C:\x.png",
        r"\\.\pipe\x.png",
        r"/\host/share/x.png",
    ] {
        assert_eq!(code(read(text, &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT", "{text}");
    }
}

#[test]
fn a_path_outside_the_project_is_refused_by_its_words_before_it_is_opened() {
    let d = dirs();
    // The file does not exist at all: the refusal is the same as for one that does, so nothing tells the two apart.
    let ghost = d.outside.join("ghost.png");
    assert_eq!(code(read(&ghost.to_string_lossy(), &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    assert_eq!(code(read("../outside/ghost.png", &cwd(&d), &roots(&d), MAX_BYTES)), "PICTURE_NOT_IN_PROJECT");
    assert!(lexically_inside(&d.project.join("out").join("..").join("a.png"), &roots(&d)));
    assert!(!lexically_inside(&d.project.join("..").join("outside").join("a.png"), &roots(&d)));
    // A legitimate file in the project still reads.
    std::fs::write(d.project.join("ok.png"), png_bytes()).unwrap();
    assert!(read("ok.png", &cwd(&d), &roots(&d), MAX_BYTES).is_ok());
    assert!(read(&format!("file:///{}", d.project.join("ok.png").to_string_lossy().replace('\\', "/")), &cwd(&d), &roots(&d), MAX_BYTES).is_ok());
}
