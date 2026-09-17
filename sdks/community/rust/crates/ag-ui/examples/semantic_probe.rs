//! Emits typed decoding results for the official TypeScript interoperability suite.
use std::io::{self, Read};

use ag_ui::{Event, RunAgentInput, RunOutcome, SubagentOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Event,
    Input,
    Outcome,
    SubagentOutcome,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    kind: Kind,
    input: Value,
}

fn decode(case: &Case) -> Result<Value, Box<dyn std::error::Error>> {
    let input = case.input.clone();
    Ok(match case.kind {
        Kind::Event => serde_json::to_value(serde_json::from_value::<Event>(input)?)?,
        Kind::Input => serde_json::to_value(serde_json::from_value::<RunAgentInput>(input)?)?,
        Kind::Outcome => {
            // The public API separates typed decoding from the non-empty-list rule.
            let outcome: RunOutcome = serde_json::from_value(input)?;
            outcome.validate()?;
            serde_json::to_value(outcome)?
        }
        Kind::SubagentOutcome => {
            serde_json::to_value(serde_json::from_value::<SubagentOutcome>(input)?)?
        }
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let cases: Vec<Case> = serde_json::from_str(&input)?;
    let results: Vec<_> = cases
        .iter()
        .map(|case| match decode(case) {
            Ok(value) => json!({"name": case.name, "accepted": true, "value": value}),
            Err(_) => json!({"name": case.name, "accepted": false}),
        })
        .collect();
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
