# Development speed

How long a developer (mostly an AI agent in its own git worktree) waits for the build, the tests and the checks, what was done about it, and what is left to try.
Measured on 2026-10-30 on one Windows 11 machine (Ryzen 7 7700, 8 cores / 16 threads, 63 GB, Rust 1.96, Node 22). Repo state: `origin/main` at #176.

## The short version

1. **Leave incremental compilation on while you work.** One edited file costs about 30 s to rebuild the Rust test binary with cargo's default
   (incremental), against about 2 to 4 minutes with `CARGO_INCREMENTAL=0`. Our old helper scripts and CI turn it off. CI should (it builds once); a person iterating should not.
2. **Run only what your change can reach**: `node scripts/test-changed.mjs`. Run **everything** once before you push: `node scripts/check.mjs`
   (Rust tests, TypeScript, vitest and the repo guards, side by side). Both replace the out-of-repo helper scripts.
3. **Find code without reading the 227 KB map**: `node scripts/where.mjs approval prompt` (about 0.6 k tokens of output instead of about 57 k).
4. **Do not flip cargo settings between runs.** A changed `CARGO_INCREMENTAL`, `CARGO_PROFILE_*_DEBUG` or `RUSTFLAGS` rebuilds the whole 220k-line crate (110 s for a "no-op" build in this study).
5. The two big structural limits are one huge Rust crate (the front end of the compiler runs on one thread for about 90 s) and about one CI run in four failing on a single flaky test. Both need a decision; see the ranked list at the end.

## How agents get a build slot

Agents that run cargo do not make a new worktree per task. There are three permanent slots (`<slot-root>\1`, `2`, `3`), each a git worktree with its own `node_modules`,
its resources and its own cargo target (`<slot-root>\target\<n>`). The path never changes, so cargo's incremental cache stays warm from task to task. One agent holds one slot, so nobody waits on cargo's file lock. UI-only work (no cargo) may still use a plain worktree.

```
node scripts/dev/slot.mjs lease --name <task> --branch <branch> [--wait 600]   # prints the slot path and the env lines
node scripts/dev/slot-prepare.mjs <n> --source <checkout with the resources>   # worktree if missing, npm ci only if the lock changed, copy resources
cd <slot-root>\<n> ; git switch -c <branch> master                            # then use the CARGO_TARGET_DIR and CARGO_BUILD_JOBS lines printed by lease
node scripts/dev/slot.mjs release <n>                                         # when done (commit first)
node scripts/dev/slot.mjs status                                              # who holds what
node scripts/dev/disk-guard.mjs [--trim]                                      # free space per drive, size per slot target
```

- A lease is a file in `<slot-root>\leases` made with an exclusive open. It expires after 3 hours (or at once if you passed `--pid` and that process is gone). `lease --release-slot` takes the fourth lease, for the release folder. All slots taken: `lease` exits with code 2 (or waits with `--wait`).
- Nothing is deleted. Released and expired leases move to `leases\old`; `disk-guard.mjs --trim` moves the `incremental` folders of unleased slots to `<trash folder>` when the drive has under 60 GB free or a target is over 40 GB.
- `PM_SLOT_ROOT` moves the whole layout (the tests use a temp folder). Never set a shared `CARGO_TARGET_DIR` by hand.
- `.cargo/config.toml` selects `rust-lld` as the linker on Windows MSVC. Indicative (busy machine, one edit then `cargo test --lib --no-run`): 75 s and 81 s with `link.exe`, 54 s with `rust-lld`. Switching linker once rebuilds everything (496 s, loaded), so do it between tasks, not mid-task.

## 1. What was measured

Quiet machine unless noted. "Loaded" means other agents were compiling at the same time (up to 15 `rustc` processes), which made wall times 1.5 to 2 times longer and noisier; the ranges show it.

### Frontend (TypeScript)

| Step | Time | Notes |
|---|---|---|
| `npm ci` | 15.7 s | 17.4 s when `node_modules` already exists (it deletes and reinstalls) |
| build `@puppet-master/shared` | 4.1 s | the app imports it through `dist/` |
| `tsc --noEmit`, app | 31.9 s first, 14 to 20 s after | service-worker config 1.6 s |
| `tsc` with the new incremental cache | 23 to 30 s first (about 3 s more than plain), **4.5 to 5 s** nothing changed, **9 to 10 s** one edit | cache in `node_modules/.cache/pm` |
| `vitest run` (470 files, 5,059 tests) | 50 to 52 s quiet; 84 s median loaded (4 runs) | before the change below |
| `vitest run`, `node` environment by default | **64 s median loaded** (4 runs), same load | 24 % faster; the jsdom setup CPU fell from about 520 s to about 330 s |
| `vite build` | 8.4 to 9.7 s | all the Rust jobs need it once |

### Rust (library test binary: `cargo test --lib --no-run`)

| Step | Time | Notes |
|---|---|---|
| Cold, empty target dir (631 build units) | 214 to 226 s | dependencies about 60 s wall, then the app crate alone about 165 s |
| Build when nothing changed | 2 s | |
| One edit, **incremental (cargo default)** | **28 to 34 s** (5 runs, quiet); 46 to 74 s, median 60 (3 runs, loaded, interleaved with the two rows below) | an edit that changes only a function body or adds an item |
| One edit, `CARGO_INCREMENTAL=0`, line tables (what plain CI does) | 156 to 287 s, median 216 (6 runs, all while loaded) | |
| One edit, `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_TEST_DEBUG=0` (the old helper flow) | 91 to 273 s, median 133 (9 runs; 91 to 125 s early on, when the machine was quiet) | |
| Link step alone | 4.6 s with `link.exe`, 3.1 s with `rust-lld` | so the linker choice is worth at most 2 to 3 s |
| Running all library tests | 151 s | 7,788 tests (+32 ignored), 16 threads, one process |
| Starting the test program for one test | 0.08 s | so one process per test (nextest) costs little |
| Target folder | about 2.4 GB without incremental; incremental data adds 3 to 5 GB | per worktree |

Where the 185 s of one non-incremental compile of the app crate goes (`-Z time-passes`, loaded machine): macro expansion 14 s, type check 39 s, borrow check 37 s
(all three on one thread), then code generation 53 s and LLVM 55 s (these run in parallel), link 5 s. Only the dependency part of a cold build runs wide.
Dependencies: 682 packages in `Cargo.lock`; the biggest single ones are `windows` 37 s, `tauri-utils` 2 x 17 s, `windows-sys` 10 s.

### Settings tried that did not help

| Setting | Result |
|---|---|
| `rust-lld` instead of `link.exe` | link step 4.6 s to 3.1 s. Whole-build differences between the two were noise (the order of the results flipped between debug settings). Harmless, not worth a repo setting. CI already uses it. |
| `debug = 0` for the app crate instead of line tables | 125 to 165 s against 156 to 241 s in one comparison, but the same comparison reversed under `rust-lld`; not conclusive, and line tables keep `file:line` in panics. Left as it is. |
| `vitest --pool threads` | 57 to 63 s against 59 to 73 s for the default; inside the noise. Not adopted. |
| `vitest --no-isolate` | breaks tests that keep state between files. Not usable. |
| Duplicate crate versions (about 50 crates have two or more) | mostly Windows platform crates pulled by tauri. The ones we could fix (`tungstenite` 0.24/0.29, `thiserror` 1/2, `rand` 0.8/0.9, `png` 0.17/0.18) cost 1 to 2 s of compile time each on a cold build (the second `thiserror-impl` 5 s) and nothing when warm. Not worth the risk. |

### Tests: the slowest and the flaky ones

Slowest library tests on their own (seconds): `handoff::tests::an_agent_cannot_raise_a_limit_card_through_ask_user` 25;
`tui::declarative::wizard::tests::visible_livetest_tests::*` 9 to 22 (five tests); `flight::tests::recording_overhead_per_chunk_is_small_next_to_the_work_the_reader_already_does` 11;
`operations_contract_tests::panes::separate_operations_can_dispatch_concurrently` 10; then about 20 tests of 4 to 8 s (`team`, `worktrees`, `missions`, `checkpoints::bisect`, `live_room`, `clip`).
Summed test time (inflated by 16 threads sharing the machine): `checkpoints` 22 %, `tui` 19 %, `worktrees` 12 %, `missions` 9 %. These are the tests that start `git` and `node`.
The whole run is limited by total work, not by one long test (the sum divided by 16 is 148 s; the run takes 151 s).

Frontend: vitest spends more time building the test environment than running tests (before the change: environment 520 s, tests 130 s, summed over workers).

Flaky: of the last 20 CI runs, 5 failed with exactly one failing test and no change to the code under it (4 of them on pushes to `main`):
`fake_tui_branch` `branch::a_branch_from_a_save_point_is_a_separate_copy_and_the_original_stays_untouched` (run 40929308995),
`fake_tui_wizard` `wizard::the_wizard_measures_an_inline_agent_that_reprints_its_conversation_and_writes_the_flag` (40849547369),
`fake_tui_issue_intake` `issue_intake::issue_intake_labeled_by_you_runs_in_a_guarded_copy_and_opens_a_draft_pr` (40846060937),
library `shell_exec::tests::powershell_pty_executes_commands_reports_failures_and_times_out` (40906284313, took 18.9 s on a loaded runner); one more library shard failure (40923619684) was not identified.
Each red run costs about 10 minutes plus a re-run. Known flaky tests from before are in [TEST-PLAN.md](TEST-PLAN.md) section 3.

### CI (GitHub Actions, four recent green runs)

| Job | Time |
|---|---|
| What changed (privacy guard + path filter) | 7 to 9 s |
| Frontend build for the Rust jobs | 21 to 33 s |
| Frontend (vitest + tsc), ubuntu | 173 to 229 s (vitest alone 140 s) |
| Rust unit tests, 3 shards, windows | 351 to 582 s |
| Fake agent e2e, 4 shards, windows | 348 to 460 s |
| Whole run | 8 m 50 s to 9 m 50 s in three of them (the slowest Rust shard decides) |

One Rust shard (run 41041178757, shard 3): about 70 s of setup and cache restore, **3 m 51 s compiling the app crate**, then 175 s running its 2,615 tests.
Every one of the 7 Rust shards compiles the same crate again, because the cache holds the dependencies, not the app crate.
CI already has: dependency cache, `rust-lld`, nextest, a path filter that skips Rust jobs for frontend-only changes, concurrency cancel on pull requests.

### Finding where things are

`docs/REPO_MAP.md` is 227 KB (about 57 k tokens), and the instruction is "read it before exploring". `scripts/where.mjs` searches its rows and `FEATURES.md` rows instead.
The 222k lines of Rust are one library crate in 1,372 files plus two small binaries.

## 2. What was changed, with before and after

| Change | Before | After |
|---|---|---|
| `scripts/check.mjs`: the checks in one command, in the repo, no personal paths | a private script outside the repo, sequential, `npm ci` every time, copies a folder from the main checkout, forces `CARGO_INCREMENTAL=0` | Rust, TypeScript and guards run side by side (the total is the slowest lane, not the sum; not timed end to end to save usage); only prepares what is missing; keeps your cargo settings |
| `scripts/test-changed.mjs`: tests your change can reach | everything, or a hand-typed filter | a change in a leaf module runs 1 to 7 modules; a one-line plan with `--dry-run` |
| `scripts/where.mjs` | read a 227 KB file | one command, about 2.5 KB of output |
| `scripts/check-merge-leftovers.mjs` (replaces the out-of-repo `dupcheck.sh`) | found by a failed compile after 2 minutes | 0.35 s |
| vitest default environment `node` (+32 test files say `// @vitest-environment jsdom`) | jsdom window built for all 470 files | 64 s against 84 s (loaded), environment CPU 520 s to 330 s. On a 4-vCPU CI runner the saving should be larger |
| `typecheck` script: `tsc --incremental` with the cache in `node_modules/.cache/pm` | 14 to 20 s every time | 4.5 to 5 s unchanged, 9 to 10 s after one edit; first run (CI) about 3 s more than plain tsc |
| `TEST-PLAN.md` counts, `ci.yml` comment | said 927 lib tests, 2,054 vitest tests, "about 2,800" | 7,788, 5,059, "about 7,800" |
| `CONTRIBUTING.md`, `docs/wiki/developing.md`, `docs/REPO_MAP.md` | | point at the scripts and this file; the sccache note no longer asks for `CARGO_INCREMENTAL=0` |

No product code and no Cargo setting was changed, and no CI check was removed. CI's workflow file changed only in a comment.
Changes not made on purpose: any `Cargo.toml` profile (the measurements above were inconclusive), the linker, vitest `pool`.

Use in practice:

```powershell
node scripts/where.mjs approval prompt      # where to look
node scripts/test-changed.mjs --dry-run      # what would run for my change
node scripts/test-changed.mjs                # run it (Rust modules + their users, vitest related, tsc)
node scripts/check.mjs                       # before a push: everything CI runs
$env:CARGO_TARGET_DIR = "<cargo target folder>"   # keep the 2 to 8 GB off the repo drive
```

`check.mjs` and `test-changed.mjs` write their logs to `<temp>/pm-check/<checkout name>/` (set `PM_CHECK_LOGS` to move them) and print one line per lane.
`test-changed.mjs` is a heuristic (a Rust file maps to its top-level module plus every module that mentions `crate::<module>`; more than 14 modules means "run all"); it can miss a far-away user, so `check.mjs` and CI stay the gate.

The gate tiers for a night run (all under `scripts/dev/`, none of them pushes or deletes a branch):

- Every agent commit: `node scripts/dev/check-quick.mjs` (tier 0: changed files vs master, the matching Rust modules plus `commands` and `bridge`, vitest related, tsc, separation and warnings guards; `--dry-run` shows the plan).
- Once per merged batch: `node scripts/dev/integrate.mjs <branches...>` merges into `night/integration`, runs `bash scripts/dev/check-batch.sh` (tier 1, the full gate) once, splits a red batch in half to name the bad branch, and fast-forwards master only when green (`--dry-run` only checks that the branches merge).
- Start of each session: `node scripts/dev/branch-age.mjs` lists unmerged branches; merge master into any marked WARN (over 30 commits or 2 days behind).
- Tests for these scripts: `npm run test:dev-scripts`.

## 3. Ideas not done, ranked by gain for effort

| # | Idea | Expected gain | Effort | Needs a decision / risk |
|---|---|---|---|---|
| 1 | **Fix the 4 flaky tests above** (three are fake-agent end-to-end tests, one a PowerShell timeout test; find what each waits on) | about 1 CI run in 4 stops needing a 10-minute re-run | medium, one test at a time | none; start with `shell_exec` (it timed out at 18.9 s) |
| 2 | **Build the Rust test binaries once in CI** (`cargo nextest archive`, then each shard only runs its share) and raise the shards from 3 to 6 | wall about 9 min to about 6 to 7 min (an estimate, not measured); 7 compiles of 3 m 51 s become 2 | 1 day, cannot be tried without a CI run | Windows path remapping of the archive; keep the old jobs until the new ones are green twice |
| 3 | **Split the 222k-line crate into a workspace** (start with leaf logic: `redact`, `flight`, `chat_index`, `tui` profiles, the replay corpus) | the front end (about 90 s, one thread) runs in parallel; an edit in a leaf crate rebuilds that crate only; a cold build could halve | weeks | `crate::tui` is used by 62 modules, `app_paths` by 60; needs a plan and an owner |
| 4 | **Windows Defender exclusions or a Dev Drive** for the worktree folders, cargo target folders and `%TEMP%` (needs admin; not measured here, the exclusion list could not be read) | the library tests start `git` and `node` thousands of times, so process creation scanning matters; typical reports are 10 to 30 % | 10 minutes | a security setting: the owner decides. Measure with `cargo test --lib` (151 s) before and after |
| 5 | **Share dependencies between worktrees** with `sccache` (opt-in notes are in CONTRIBUTING) | a new worktree's cold build from about 220 s to about 160 s (dependencies were 60 s of it); not tested, sccache is not installed here | 30 minutes per machine | a download; do not share one `CARGO_TARGET_DIR` instead (cargo locks it, parallel agents would queue) |
| 6 | **Stable build id in test runs**: `build.rs` watches the git branch file and `packages/app/src`, so every commit and every frontend edit re-stamps `PM_BUILD_ID` and recompiles (measured in section 4: 57 s incremental, 185 s not, for a file touched with no change) | removes that rebuild after a commit or a frontend edit | small (`PM_STABLE_BUILD_ID=1` read by `build.rs`, set by `check.mjs`) | touches `build.rs`, which feeds `/health`; the release rule must stay |
| 7 | Drop `cdylib` and `staticlib` from `[lib] crate-type` (they exist for mobile targets) | not measured (the run was stopped); the link step of the test binary is only 3 to 5 s, the dev app links three outputs | 5 minutes | breaks a future mobile build; decide whether mobile is planned |
| 8 | `happy-dom` instead of jsdom for the 300 DOM tests | a further 10 to 15 s of the 64 s vitest run | 1 day | behaviour differences in layout and selection tests |
| 9 | Run `cargo nextest` locally too (CI does) | unknown, not compared; one process per test costs 0.08 s start each, about 620 s of CPU over 7,788 tests (about 40 s of wall on 16 threads), in exchange for tests that cannot share global state | needs a download | ask first |
| 10 | Split `REPO_MAP.md` into one file per section (3.x module index, 4, 5, 7) and keep `where.mjs` over all of them | agents read 5 to 30 KB where needed | 2 hours | none |
| 11 | Clippy and `rustfmt --check` are not in CI | catches things earlier at the cost of a parallel job (not timed here) | 1 hour | a policy choice |

## 4. Extra measurements

Build after touching one frontend file (`packages/app/src/lib/focus.ts`, mtime only, no content change; `build.rs` watches `../src`):

| Setting | Rebuild of the test binary |
|---|---|
| nothing touched | 3.6 s |
| incremental (default) | 57 s (loaded machine) |
| `CARGO_INCREMENTAL=0` | 185 s (loaded machine) |

The same happens after a commit (the branch ref file is watched too). Switching `CARGO_INCREMENTAL` once cost 172 s.

Not measured, and stopped on purpose to save usage: the cost of the `cdylib`/`staticlib` crate types, `sccache`, Windows Defender exclusions, nextest locally.

## 5. Writing tests that do not flake

A test passes on a quiet machine and fails when ten builds run beside it: that is a flake, and the cause is nearly always a guess about time. Rules for tests (and for agent briefs that ask for tests):

- **Wait for an event or a condition, with a deadline. Never a bare sleep.** Poll the thing you need (a file exists, a pid is gone, an event arrived) every few milliseconds and fail only when a generous deadline passes. A fixed `sleep` that is "long enough" is a bug waiting for a busy machine.
- **Tests share nothing process-wide**: no shared tables, no fixed ports, no fixed temp names (use a unique folder per test).
- **A test that passes only on retry is a flake, not a pass.** Run `node scripts/dev/flakes.mjs` (nextest profile `local`, 2 retries); it writes every retried test with the date and branch to the flake ledger (set `FLAKES_LOG` to choose the file). Fix the names in the ledger.
- **The sleep budget** (`src/sleep_budget_tests.rs`) counts `thread::sleep(` and `time::sleep(` lines in test files and fails when the count grows. When you remove sleeps, lower `BUDGET` in the same change.
- Production code that starts helper processes must not depend on timing either. Example fixed on 2026-11-12: the ACP process-tree stop ended the Windows job, but a helper started before the adapter was put in the job was not in it, so under load the helper survived a cancel. `Containment::terminate` now walks the tree by pid first, then ends the job. Before the fix `acp::bridge::tests::cancel_kills_the_whole_process_tree` and `...the_host_cancel_and_failure_paths_work_through_the_bridge` failed 4 and 12 times in 50 runs under load; after it, 0 and 0.
