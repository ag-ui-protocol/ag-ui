mod lifecycle_support;
use ag_ui_client::{
    Agent,
    agent::AgentError,
    core::processing::Diagnostic,
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Warnings(Arc<Mutex<Vec<Diagnostic>>>);
#[async_trait::async_trait]
impl AgentSubscriber for Warnings {
    async fn on_diagnostic(
        &self,
        diagnostic: &Diagnostic,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(diagnostic.clone());
        Ok(())
    }
}

fn invalid_patches() -> Vec<Value> {
    let mut patches = vec![json!([
        {"op":"add","path":"/a","value":1},
        {"op":"move","from":"/a","path":"/missing/x"}
    ])];
    for kind in ["move", "copy"] {
        let mut operations = vec![json!({"op":"add","path":"/c","value":{}})];
        for _ in 0..4096 {
            operations.extend([
                json!({"op":"add","path":"/n","value":{}}),
                json!({"op":kind,"from":"/c","path":"/n/c"}),
                json!({"op":"move","from":"/n","path":"/c"}),
            ]);
        }
        patches.push(json!(operations));
    }
    patches
}

#[tokio::test]
async fn state_patch_panics_and_depth_growth_become_warnings_without_partial_commit() {
    for patch in invalid_patches() {
        let mut request = input("requested");
        request.state = json!({"keep":1});
        let warnings = Warnings::default();
        let result = Script(vec![
            start("requested"),
            json!({"type":"STATE_DELTA","delta":patch}),
            finish("requested"),
        ])
        .run_input(&request, (warnings.clone(),))
        .await
        .unwrap();
        assert_eq!(result.new_state, json!({"keep":1}));
        assert_eq!(warnings.0.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn activity_patch_panics_and_depth_growth_become_warnings_without_partial_commit() {
    for patch in invalid_patches() {
        let warnings = Warnings::default();
        let result = Script(vec![start("requested"),
            json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"original","content":{"keep":1}}),
            json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"changed","patch":patch}),
            finish("requested")])
            .run_input(&input("requested"), (warnings.clone(),)).await.unwrap();
        let messages = values(&result.messages);
        assert_eq!(messages[0]["content"], json!({"keep":1}));
        assert_eq!(messages[0]["activityType"], "original");
        assert_eq!(warnings.0.lock().unwrap().len(), 1);
    }
}
