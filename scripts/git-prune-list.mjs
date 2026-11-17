/**
 * Files of the bundled Git (MinGit) that the app never runs, left out of `resources/git` (N5-5, UPDATE-SIZE.md
 * proposal B). Paths are relative to `resources/git`. Shared by fetch-git.mjs (removes them) and
 * check-release-bundle.mjs (fails the build if one is still staged).
 *
 * Kept on purpose: everything git over HTTPS needs (git.exe, git-remote-http(s).exe, git-http-fetch.exe for servers
 * without the smart protocol, libcurl, OpenSSL, ca certificates) and the whole Git Credential Manager sign-in window
 * (git-credential-manager.exe and its Avalonia, SkiaSharp, HarfBuzzSharp, msalruntime and Microsoft.Identity files,
 * av_libglesv2.dll): etc/gitconfig sets `credential.helper = manager`, and a person's own `git push` in a terminal pane
 * opens that window to sign in to GitHub. Agent panes reset the helper (pty/env_guard.rs), so only the person's own
 * pushes use it. Not removed because it is not certain nothing needs it.
 */
export const GIT_PRUNED = [
  'ucrt64/bin/scalar.exe', // large-repo tool, never called
  'cmd/scalar.exe', // its small launcher in cmd/
  'ucrt64/bin/git-http-push.exe', // push over dumb WebDAV http; smart http push is inside git-remote-https.exe
  'ucrt64/bin/docx2txt.exe', // diff helper for Word files
  'ucrt64/bin/docx-strip-pii.exe', // helper of the one above
  'ucrt64/bin/brotli.exe', // command line tool; the libbrotli*.dll files curl needs stay
  'ucrt64/bin/psl.exe', // public suffix list command line tool; libpsl-5.dll stays
  'ucrt64/bin/psl-make-dafsa', // build-time script of libpsl
];

/** The files that must stay: the check fails if the prune ever eats one of these. */
export const GIT_MUST_KEEP = [
  'cmd/git.exe',
  'ucrt64/bin/git.exe',
  'ucrt64/bin/git-remote-https.exe',
  'ucrt64/bin/git-remote-http.exe',
  'ucrt64/bin/git-http-fetch.exe',
  'ucrt64/bin/git-receive-pack.exe',
  'ucrt64/bin/git-upload-pack.exe',
  'ucrt64/bin/libcurl-4.dll',
  'ucrt64/bin/libssl-3-x64.dll',
  'ucrt64/bin/git-credential-manager.exe',
];
