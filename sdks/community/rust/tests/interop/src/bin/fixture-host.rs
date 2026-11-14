use ag_ui_interop_fixture::{FixtureHost, TestResult, scenarios};
use std::io::Write;

fn main() -> TestResult<()> {
    let mut args = std::env::args().skip(1);
    let scenario = args
        .next()
        .ok_or("usage: fixture-host SCENARIO STEP TRACE.json")?;
    let index: usize = args.next().ok_or("missing step")?.parse()?;
    let trace_path = args.next().ok_or("missing trace path")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let step = scenarios()
        .get(&scenario)
        .and_then(|steps| steps.get(index))
        .cloned()
        .ok_or("unknown scenario or step")?;
    let host = FixtureHost::start(step)?;
    println!("{}", host.url);
    std::io::stdout().flush()?;
    let trace = host.finish()?;
    std::fs::write(trace_path, serde_json::to_vec_pretty(&trace)?)?;
    Ok(())
}
