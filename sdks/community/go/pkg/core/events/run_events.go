package events

import (
	"encoding/json"
	"fmt"
)

// RunStartedEvent indicates that an agent run has started
type RunStartedEvent struct {
	*BaseEvent
	ThreadIDValue string `json:"threadId"`
	RunIDValue    string `json:"runId"`
}

// NewRunStartedEvent creates a new run started event
func NewRunStartedEvent(threadID, runID string) *RunStartedEvent {
	return &RunStartedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunStarted),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}
}

// NewRunStartedEventWithOptions creates a new run started event with options
func NewRunStartedEventWithOptions(threadID, runID string, options ...RunStartedOption) *RunStartedEvent {
	event := &RunStartedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunStarted),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunStartedOption defines options for creating run started events
type RunStartedOption func(*RunStartedEvent)

// WithAutoRunID automatically generates a unique run ID if the provided runID is empty
func WithAutoRunID() RunStartedOption {
	return func(e *RunStartedEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// WithAutoThreadID automatically generates a unique thread ID if the provided threadID is empty
func WithAutoThreadID() RunStartedOption {
	return func(e *RunStartedEvent) {
		if e.ThreadIDValue == "" {
			e.ThreadIDValue = GenerateThreadID()
		}
	}
}

// Validate validates the run started event
func (e *RunStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadIDValue == "" {
		return fmt.Errorf("RunStartedEvent validation failed: threadId field is required")
	}

	if e.RunIDValue == "" {
		return fmt.Errorf("RunStartedEvent validation failed: runId field is required")
	}

	return nil
}

// ThreadID returns the thread ID
func (e *RunStartedEvent) ThreadID() string {
	return e.ThreadIDValue
}

// RunID returns the run ID
func (e *RunStartedEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// RunFinishedEvent indicates that an agent run has finished successfully
type RunFinishedEvent struct {
	*BaseEvent
	ThreadIDValue string      `json:"threadId"`
	RunIDValue    string      `json:"runId"`
	Result        interface{} `json:"result,omitempty"`
}

// NewRunFinishedEvent creates a new run finished event
func NewRunFinishedEvent(threadID, runID string) *RunFinishedEvent {
	return &RunFinishedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunFinished),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}
}

// NewRunFinishedEventWithOptions creates a new run finished event with options
func NewRunFinishedEventWithOptions(threadID, runID string, options ...RunFinishedOption) *RunFinishedEvent {
	event := &RunFinishedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunFinished),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunFinishedOption defines options for creating run finished events
type RunFinishedOption func(*RunFinishedEvent)

// WithAutoRunIDFinished automatically generates a unique run ID if the provided runID is empty
func WithAutoRunIDFinished() RunFinishedOption {
	return func(e *RunFinishedEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// WithAutoThreadIDFinished automatically generates a unique thread ID if the provided threadID is empty
func WithAutoThreadIDFinished() RunFinishedOption {
	return func(e *RunFinishedEvent) {
		if e.ThreadIDValue == "" {
			e.ThreadIDValue = GenerateThreadID()
		}
	}
}

// WithResult sets the result for the run finished event
func WithResult(result interface{}) RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Result = result
	}
}

// Validate validates the run finished event
func (e *RunFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadIDValue == "" {
		return fmt.Errorf("RunFinishedEvent validation failed: threadId field is required")
	}

	if e.RunIDValue == "" {
		return fmt.Errorf("RunFinishedEvent validation failed: runId field is required")
	}

	return nil
}

// ThreadID returns the thread ID
func (e *RunFinishedEvent) ThreadID() string {
	return e.ThreadIDValue
}

// RunID returns the run ID
func (e *RunFinishedEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// RunErrorEvent indicates that an agent run has encountered an error
type RunErrorEvent struct {
	*BaseEvent
	Code       *string `json:"code,omitempty"`
	Message    string  `json:"message"`
	RunIDValue string  `json:"runId,omitempty"`
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
		e.RunIDValue = runID
	}
}

// WithAutoRunIDError automatically generates a unique run ID if the provided runID is empty
func WithAutoRunIDError() RunErrorOption {
	return func(e *RunErrorEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// Validate validates the run error event
func (e *RunErrorEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Message == "" {
		return fmt.Errorf("RunErrorEvent validation failed: message field is required")
	}

	return nil
}

// RunID returns the run ID
func (e *RunErrorEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunErrorEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
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

// NewStepStartedEventWithOptions creates a new step started event with options
func NewStepStartedEventWithOptions(stepName string, options ...StepStartedOption) *StepStartedEvent {
	event := &StepStartedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepStarted),
		StepName:  stepName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// StepStartedOption defines options for creating step started events
type StepStartedOption func(*StepStartedEvent)

// WithAutoStepName automatically generates a unique step name if the provided stepName is empty
func WithAutoStepName() StepStartedOption {
	return func(e *StepStartedEvent) {
		if e.StepName == "" {
			e.StepName = GenerateStepID()
		}
	}
}

// Validate validates the step started event
func (e *StepStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("StepStartedEvent validation failed: stepName field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
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

// NewStepFinishedEventWithOptions creates a new step finished event with options
func NewStepFinishedEventWithOptions(stepName string, options ...StepFinishedOption) *StepFinishedEvent {
	event := &StepFinishedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepFinished),
		StepName:  stepName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// StepFinishedOption defines options for creating step finished events
type StepFinishedOption func(*StepFinishedEvent)

// WithAutoStepNameFinished automatically generates a unique step name if the provided stepName is empty
func WithAutoStepNameFinished() StepFinishedOption {
	return func(e *StepFinishedEvent) {
		if e.StepName == "" {
			e.StepName = GenerateStepID()
		}
	}
}

// Validate validates the step finished event
func (e *StepFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("StepFinishedEvent validation failed: stepName field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}
