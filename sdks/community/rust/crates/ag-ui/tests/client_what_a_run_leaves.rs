//! What a run leaves a thread holding can be saved and restored:
//! `Thread::restore` accepts `Thread::snapshot` whatever the streams the
//! thread read carried. Where a stream carries what the conversation cannot
//! hold as it is, the event is made to fit when it arrives, and the thread
//! says so when the stream broke a rule to get there.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunEnd, RunReport, Thread, verify_all};
use ag_ui::{Event, Message, SubagentStartedEvent, TextMessageRole};

fn subagent(id: &str, parent: Option<&str>) -> Event {
    let started = SubagentStartedEvent::new(id, "worker");
    match parent {
        Some(parent) => started.with_parent_subagent(parent).into(),
        None => started.into(),
    }
}

/// A run with id `r` and these events between its boundaries.
fn run(id: &str, events: Vec<Event>) -> Vec<Event> {
    let mut run = vec![Event::run_started("t", id)];
    run.extend(events);
    run.push(Event::run_finished_success("t", id));
    run
}

struct Case {
    name: &'static str,
    runs: Vec<Vec<Event>>,
    /// What the thread says, each diagnostic a warning.
    warnings: Vec<&'static str>,
    check: fn(&Thread<ReplayTransport>),
}

fn cases() -> Vec<Case> {
    vec![
        // AG-UI 1.0, `basic`: a `messageId` "MUST be unique within its
        // thread". The snapshot breaks that, and the thread keeps one copy:
        // the last, in the place of the first, as the reference client's
        // map by id does for an id it holds. Before: two messages "a-1".
        Case {
            name: "a snapshot that repeats an id",
            runs: vec![run(
                "r",
                vec![Event::messages_snapshot(vec![
                    Message::assistant("a-1", "first"),
                    Message::user("u-1", "between"),
                    Message::assistant("a-1", "second"),
                ])],
            )],
            warnings: vec![
                "MESSAGES_SNAPSHOT carries message id \"a-1\" more than once: the last copy is \
                 kept, where the first stood. A message id is unique within its thread",
            ],
            check: |thread| {
                assert_eq!(
                    thread.messages(),
                    [
                        Message::assistant("a-1", "second"),
                        Message::user("u-1", "between")
                    ]
                );
            },
        },
        // 1.0 makes every identifier an opaque string and sets no minimum
        // length (`basic`, "Identifiers"; the schema), so the empty string
        // is an id, and the thread keeps it. Before: restore refused it,
        // "message ID \"\" is empty or duplicated".
        Case {
            name: "an empty message id",
            runs: vec![run(
                "r",
                vec![
                    Event::text_message_start("", TextMessageRole::Assistant),
                    Event::text_message_content("", "hello"),
                    Event::text_message_end(""),
                ],
            )],
            warnings: vec![],
            check: |thread| assert_eq!(thread.applier().text_of(""), Some("hello")),
        },
        Case {
            name: "an empty subagent run id",
            runs: vec![run(
                "r",
                vec![subagent("", None), Event::subagent_finished_success("")],
            )],
            warnings: vec![],
            check: |thread| assert!(thread.subagent(&"".into()).is_some()),
        },
        // Two runs announce two invocations with the parent link the other
        // way round, each run well formed. The newest announcement stands:
        // `a` is under `b`, as the second run says, and the older link, from
        // `b` to `a`, would close a circle, so `b` stands directly under the
        // parent agent, as its own second announcement put it. Before: each
        // was the other's parent, "cyclic subagent ancestry".
        Case {
            name: "two runs that nest two subagents the other way round",
            runs: vec![
                run(
                    "r",
                    vec![
                        subagent("a", None),
                        subagent("b", Some("a")),
                        Event::subagent_finished_success("b"),
                        Event::subagent_finished_success("a"),
                    ],
                ),
                run(
                    "r-2",
                    vec![
                        subagent("b", None),
                        subagent("a", Some("b")),
                        Event::subagent_finished_success("a"),
                        Event::subagent_finished_success("b"),
                    ],
                ),
            ],
            warnings: vec![],
            check: |thread| {
                let parent = |id: &str| {
                    let subagent = thread.subagent(&id.into()).unwrap();
                    subagent
                        .parent_subagent_run_id
                        .as_ref()
                        .map(|id| id.as_str().to_owned())
                };
                assert_eq!(parent("a").as_deref(), Some("b"));
                assert_eq!(parent("b"), None);
            },
        },
    ]
}

#[tokio::test]
async fn what_a_run_leaves_restores() {
    for case in cases() {
        let name = case.name;
        let transport = ReplayTransport::with_runs(case.runs.clone());
        // Each run is the one its request asked for.
        let ids: Vec<String> = case
            .runs
            .iter()
            .map(|run| {
                let Event::RunStarted(started) = &run[0] else {
                    unreachable!()
                };
                started.run_id.as_str().to_owned()
            })
            .collect();
        let mut thread = Thread::new(transport, "t");
        let mut reports: Vec<RunReport> = Vec::new();
        for (run, id) in case.runs.iter().zip(&ids) {
            verify_all(run).unwrap_or_else(|error| panic!("{name}: {error}"));
            thread.set_next_run_id(id.as_str());
            reports.push(thread.run().unwrap().collect_report().await);
        }
        let mut said = Vec::new();
        for report in &reports {
            assert_eq!(report.end, RunEnd::Success { result: None }, "{name}");
            for diagnostic in &report.diagnostics {
                assert_eq!(diagnostic.kind, "warning", "{name}: {diagnostic:?}");
                said.push(diagnostic.message.as_str());
            }
        }
        assert_eq!(said, case.warnings, "{name}");
        (case.check)(&thread);

        let restored = Thread::<_>::restore(ReplayTransport::new([]), thread.snapshot())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(restored.messages(), thread.messages(), "{name}");
        assert_eq!(restored.subagents(), thread.subagents(), "{name}");
        // And what it holds is what a merge reads: an id held once.
        let mut seen = std::collections::HashSet::new();
        assert!(
            thread
                .messages()
                .iter()
                .all(|message| seen.insert(message.id())),
            "{name}"
        );
    }
}
