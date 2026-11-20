use ag_ui_core::{history::keep_tool_results_with_calls, types::Message};
use serde_json::json;
fn call(id: &str, calls: &[&str]) -> Message {
    serde_json::from_value(json!({"id":id,"role":"assistant","toolCalls":calls.iter().map(|c| json!({"id":c,"type":"function","function":{"name":"f","arguments":"{}"}})).collect::<Vec<_>>()})).unwrap()
}
fn tool(id: &str, call: &str) -> Message {
    serde_json::from_value(json!({"id":id,"role":"tool","toolCallId":call,"content":"done"}))
        .unwrap()
}
fn text(id: &str) -> Message {
    serde_json::from_value(json!({"id":id,"role":"assistant","content":"answer"})).unwrap()
}
fn check(mut messages: Vec<Message>, expected: &[&str]) {
    keep_tool_results_with_calls(&mut messages);
    assert_eq!(
        messages.iter().map(|m| m.id().as_ref()).collect::<Vec<_>>(),
        expected
    );
    let once = messages.clone();
    keep_tool_results_with_calls(&mut messages);
    assert_eq!(messages, once, "ordering repair must be idempotent");
}
#[test]
fn parallel_results_keep_delivery_order_and_reasoning_stays_with_text() {
    let reasoning =
        serde_json::from_value(json!({"id":"r","role":"reasoning","content":"thinking"})).unwrap();
    let activity = serde_json::from_value(
        json!({"id":"ui","role":"activity","activityType":"progress","content":{}}),
    )
    .unwrap();
    check(
        vec![
            call("a", &["c1", "c2"]),
            reasoning,
            activity,
            text("reply"),
            tool("t2", "c2"),
            tool("t1", "c1"),
        ],
        &["a", "t2", "t1", "r", "ui", "reply"],
    );
}
#[test]
fn reused_ids_reserve_in_place_results_and_repair_newest_detached_first() {
    check(
        vec![
            call("a1", &["c"]),
            text("x"),
            tool("t1", "c"),
            call("a2", &["c"]),
            tool("t2", "c"),
        ],
        &["a1", "t1", "x", "a2", "t2"],
    );
    check(
        vec![
            call("a1", &["c"]),
            call("a2", &["c"]),
            text("x"),
            tool("t1", "c"),
            tool("t2", "c"),
        ],
        &["a1", "t1", "a2", "t2", "x"],
    );
}
#[test]
fn early_results_move_only_for_unique_call_slot() {
    check(
        vec![tool("t", "c"), text("x"), call("a", &["c"])],
        &["x", "a", "t"],
    );
    check(
        vec![tool("t", "c"), call("a1", &["c"]), call("a2", &["c"])],
        &["t", "a1", "a2"],
    );
    check(vec![tool("t", "missing"), text("x")], &["t", "x"]);
}
#[test]
fn duplicate_results_do_not_steal_answered_slots() {
    check(
        vec![
            call("a", &["c"]),
            tool("t1", "c"),
            text("x"),
            tool("t2", "c"),
        ],
        &["a", "t1", "x", "t2"],
    );
    check(
        vec![
            call("a", &["c", "c"]),
            text("x"),
            tool("t1", "c"),
            tool("t2", "c"),
        ],
        &["a", "t1", "t2", "x"],
    );
}
