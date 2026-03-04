package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestActivitySnapshotEventBasics(t *testing.T) {
	content := map[string]any{"status": "draft"}

	event := NewActivitySnapshotEvent("activity-1", "PLAN", content)

	assert.Equal(t, EventTypeActivitySnapshot, event.Type())
	assert.Equal(t, "activity-1", event.MessageID)
	assert.Equal(t, "PLAN", event.ActivityType)
	require.NotNil(t, event.Replace)
	assert.True(t, *event.Replace)
	assert.NoError(t, event.Validate())

	event = event.WithReplace(false)
	require.NotNil(t, event.Replace)
	assert.False(t, *event.Replace)
}

func TestActivitySnapshotEventValidationAndJSON(t *testing.T) {
	event := NewActivitySnapshotEvent("activity-1", "PLAN", map[string]any{"status": "draft"})

	data, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, string(EventTypeActivitySnapshot), decoded["type"])
	assert.Equal(t, "activity-1", decoded["messageId"])
	assert.Equal(t, "PLAN", decoded["activityType"])
	content, ok := decoded["content"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "draft", content["status"])

	event.MessageID = ""
	assert.Error(t, event.Validate())

	event.MessageID = "activity-1"
	event.ActivityType = ""
	assert.Error(t, event.Validate())

	event.ActivityType = "PLAN"
	event.Content = nil
	assert.Error(t, event.Validate())

	event.Content = map[string]any{"status": "draft"}
	event.BaseEvent.EventType = ""
	assert.Error(t, event.Validate())
}

func TestActivitySnapshotEvent_MissingActivityType(t *testing.T) {
	event := NewActivitySnapshotEvent("activity-1", "", map[string]any{"status": "draft"})
	err := event.Validate()
	assert.Error(t, err)
}

func TestActivityDeltaEventValidationAndJSON(t *testing.T) {
	patch := []JSONPatchOperation{{Op: "replace", Path: "/status", Value: "done"}}
	event := NewActivityDeltaEvent("activity-1", "PLAN", patch)

	assert.Equal(t, EventTypeActivityDelta, event.Type())
	assert.NoError(t, event.Validate())

	data, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, string(EventTypeActivityDelta), decoded["type"])
	assert.Equal(t, "activity-1", decoded["messageId"])
	assert.Equal(t, "PLAN", decoded["activityType"])
	items, ok := decoded["patch"].([]any)
	require.True(t, ok)
	assert.Len(t, items, 1)

	event.MessageID = ""
	assert.Error(t, event.Validate())

	event.MessageID = "activity-1"
	event.Patch = []JSONPatchOperation{}
	assert.Error(t, event.Validate())

	event.Patch = []JSONPatchOperation{{Op: "invalid", Path: "/status"}}
	assert.Error(t, event.Validate())

	event.Patch = []JSONPatchOperation{{Op: "replace", Path: "/status", Value: "ok"}}
	event.ActivityType = ""
	assert.Error(t, event.Validate())

	event.ActivityType = "PLAN"
	event.BaseEvent.EventType = ""
	assert.Error(t, event.Validate())
}

func TestActivityDeltaEvent_MissingActivityType(t *testing.T) {
	event := NewActivityDeltaEvent("activity-1", "", []JSONPatchOperation{{Op: "replace", Path: "/status", Value: "done"}})
	err := event.Validate()
	assert.Error(t, err)
}
