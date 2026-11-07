//! Interop harness: normalize incoming JSON through the Rust event types.
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let events: Vec<ag_ui::Event> = serde_json::from_str(&input)?;
    serde_json::to_writer(io::stdout().lock(), &events)?;
    Ok(())
}
