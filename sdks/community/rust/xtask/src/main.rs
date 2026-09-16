//! Repo automation entry point.
//!
//! Run with `cargo run -p ag-ui-xtask -- <subcommand>`.

mod drift;

use std::process::ExitCode;

/// The check could not be performed — distinct from having found drift.
const EXIT_ERROR: u8 = 2;

const HELP: &str = "\
xtask — repo automation for ag-ui-rust

USAGE
    cargo run -p ag-ui-xtask -- <subcommand> [options]

SUBCOMMANDS
    drift-check            Compare the Rust event types against the vendored
                           snapshot of the upstream TypeScript source of truth.
                           Offline and deterministic; this is the CI gate.

DRIFT-CHECK OPTIONS
    --local               Compare with this checkout's TypeScript events.ts.
                           Offline; required for monorepo CI, including TS-only PRs.
    --upstream             Additionally fetch upstream and report whether the
                           vendored baseline itself has gone stale. Needs the
                           network, so keep it out of the required CI job.
    --refresh              Re-fetch upstream and rewrite the vendored baseline,
                           recording the upstream commit and the fetch date.
                           This is how a human accepts an upstream change.

EXIT CODES
    0  no drift
    1  drift found (or, with --upstream, the baseline is stale)
    2  the check could not run
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("xtask: {message}");
            ExitCode::from(EXIT_ERROR)
        }
    }
}

fn dispatch(args: &[String]) -> Result<u8, String> {
    let Some((subcommand, options)) = args.split_first() else {
        print!("{HELP}");
        return Ok(EXIT_ERROR);
    };

    match subcommand.as_str() {
        "-h" | "--help" | "help" => {
            print!("{HELP}");
            Ok(drift::EXIT_OK)
        }
        "drift-check" => drift::run(parse_drift_args(options)?),
        other => Err(format!(
            "unknown subcommand `{other}`.\nRun `cargo run -p ag-ui-xtask -- --help` for the list."
        )),
    }
}

fn parse_drift_args(options: &[String]) -> Result<drift::Args, String> {
    let mut parsed = drift::Args::default();
    for option in options {
        match option.as_str() {
            "--local" => parsed.local = true,
            "--upstream" => parsed.upstream = true,
            "--refresh" => parsed.refresh = true,
            other => {
                return Err(format!(
                    "unknown option `{other}` for drift-check.\n\
                     Valid options are --local, --upstream and --refresh."
                ));
            }
        }
    }
    if parsed.local && (parsed.refresh || parsed.upstream) {
        return Err("--local cannot be combined with --upstream or --refresh".to_owned());
    }
    if parsed.refresh && parsed.upstream {
        return Err("--refresh already re-reads upstream; drop --upstream.\n\
             Run `drift-check` on its own afterwards to compare the Rust types against the \
             new baseline."
            .to_string());
    }
    Ok(parsed)
}
