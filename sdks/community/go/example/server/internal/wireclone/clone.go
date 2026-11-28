package wireclone

import (
	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// Messages returns an application-owned wire transcript. It preserves typed
// multimodal content while recursively copying its JSON-shaped mutable values.
// Missing message IDs are assigned once at the ownership boundary.
func Messages(in []aguitypes.Message) []aguitypes.Message {
	out := make([]aguitypes.Message, len(in))
	for i := range in {
		out[i] = in[i]
		if out[i].ID == "" {
			out[i].ID = aguievents.GenerateMessageID()
		}
		out[i].ToolCalls = append([]aguitypes.ToolCall(nil), in[i].ToolCalls...)
		if parts, ok := in[i].Content.([]aguitypes.InputContent); ok {
			out[i].Content = inputContents(parts)
		} else {
			out[i].Content = jsonValue(in[i].Content)
		}
	}
	return out
}

func inputContents(in []aguitypes.InputContent) []aguitypes.InputContent {
	out := make([]aguitypes.InputContent, len(in))
	for i := range in {
		out[i] = in[i]
		if in[i].Source != nil {
			source := *in[i].Source
			out[i].Source = &source
		}
		out[i].Metadata = jsonValue(in[i].Metadata)
	}
	return out
}

func jsonValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			out[key] = jsonValue(item)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i := range value {
			out[i] = jsonValue(value[i])
		}
		return out
	default:
		return value
	}
}
