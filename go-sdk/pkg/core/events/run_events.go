package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
)

// RunStartedEvent indicates that an agent run has started
type RunStartedEvent struct {
	*BaseEvent
	ThreadID string `json:"threadId"`
	RunID    string `json:"runId"`
}

// NewRunStartedEvent creates a new run started event
func NewRunStartedEvent(threadID, runID string) *RunStartedEvent {
	return &RunStartedEvent{
		BaseEvent: NewBaseEvent(EventTypeRunStarted),
		ThreadID:  threadID,
		RunID:     runID,
	}
}

// Validate validates the run started event
func (e *RunStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadID == "" {
		return fmt.Errorf("thread ID is required")
	}

	if e.RunID == "" {
		return fmt.Errorf("run ID is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *RunStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *RunStartedEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.RunStartedEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		ThreadId:  e.ThreadID,
		RunId:     e.RunID,
	}

	return &generated.Event{
		Event: &generated.Event_RunStarted{
			RunStarted: pbEvent,
		},
	}, nil
}

// RunFinishedEvent indicates that an agent run has finished successfully
type RunFinishedEvent struct {
	*BaseEvent
	ThreadID string `json:"threadId"`
	RunID    string `json:"runId"`
}

// NewRunFinishedEvent creates a new run finished event
func NewRunFinishedEvent(threadID, runID string) *RunFinishedEvent {
	return &RunFinishedEvent{
		BaseEvent: NewBaseEvent(EventTypeRunFinished),
		ThreadID:  threadID,
		RunID:     runID,
	}
}

// Validate validates the run finished event
func (e *RunFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadID == "" {
		return fmt.Errorf("thread ID is required")
	}

	if e.RunID == "" {
		return fmt.Errorf("run ID is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *RunFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *RunFinishedEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.RunFinishedEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		ThreadId:  e.ThreadID,
		RunId:     e.RunID,
	}

	return &generated.Event{
		Event: &generated.Event_RunFinished{
			RunFinished: pbEvent,
		},
	}, nil
}

// RunErrorEvent indicates that an agent run has encountered an error
type RunErrorEvent struct {
	*BaseEvent
	Code    *string `json:"code,omitempty"`
	Message string  `json:"message"`
	RunID   string  `json:"runId,omitempty"`
}

// NewRunErrorEvent creates a new run error event
func NewRunErrorEvent(message string, options ...RunErrorOption) *RunErrorEvent {
	event := &RunErrorEvent{
		BaseEvent: NewBaseEvent(EventTypeRunError),
		Message:   message,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunErrorOption defines options for creating run error events
type RunErrorOption func(*RunErrorEvent)

// WithErrorCode sets the error code
func WithErrorCode(code string) RunErrorOption {
	return func(e *RunErrorEvent) {
		e.Code = &code
	}
}

// WithRunID sets the run ID for the error
func WithRunID(runID string) RunErrorOption {
	return func(e *RunErrorEvent) {
		e.RunID = runID
	}
}

// Validate validates the run error event
func (e *RunErrorEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Message == "" {
		return fmt.Errorf("error message is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *RunErrorEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *RunErrorEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.RunErrorEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Message:   e.Message,
	}

	if e.Code != nil {
		pbEvent.Code = e.Code
	}

	return &generated.Event{
		Event: &generated.Event_RunError{
			RunError: pbEvent,
		},
	}, nil
}

// StepStartedEvent indicates that an agent step has started
type StepStartedEvent struct {
	*BaseEvent
	StepName string `json:"stepName"`
}

// NewStepStartedEvent creates a new step started event
func NewStepStartedEvent(stepName string) *StepStartedEvent {
	return &StepStartedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepStarted),
		StepName:  stepName,
	}
}

// Validate validates the step started event
func (e *StepStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("step name is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *StepStartedEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.StepStartedEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		StepName:  e.StepName,
	}

	return &generated.Event{
		Event: &generated.Event_StepStarted{
			StepStarted: pbEvent,
		},
	}, nil
}

// StepFinishedEvent indicates that an agent step has finished
type StepFinishedEvent struct {
	*BaseEvent
	StepName string `json:"stepName"`
}

// NewStepFinishedEvent creates a new step finished event
func NewStepFinishedEvent(stepName string) *StepFinishedEvent {
	return &StepFinishedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepFinished),
		StepName:  stepName,
	}
}

// Validate validates the step finished event
func (e *StepFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("step name is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *StepFinishedEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.StepFinishedEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		StepName:  e.StepName,
	}

	return &generated.Event{
		Event: &generated.Event_StepFinished{
			StepFinished: pbEvent,
		},
	}, nil
}
