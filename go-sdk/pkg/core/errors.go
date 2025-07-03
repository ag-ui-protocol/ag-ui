package core

import (
	"errors"
	"fmt"
)

// Sentinel errors
var (
	ErrNotImplemented = errors.New("feature not yet implemented")
	ErrInvalidConfig  = errors.New("invalid configuration")
	ErrAgentNotFound  = errors.New("agent not found")
	ErrStreamClosed   = errors.New("stream closed")
)

// ConfigError represents configuration-related errors
type ConfigError struct {
	Field string
	Value any
	Err   error
}

func (e *ConfigError) Error() string {
	return fmt.Sprintf("config error in field %s (value: %v): %v", e.Field, e.Value, e.Err)
}

func (e *ConfigError) Unwrap() error {
	return e.Err
}

// AgentError represents agent-specific errors
type AgentError struct {
	AgentName string
	EventID   string
	Err       error
}

func (e *AgentError) Error() string {
	return fmt.Sprintf("agent %s failed processing event %s: %v", e.AgentName, e.EventID, e.Err)
}

func (e *AgentError) Unwrap() error {
	return e.Err
}

// ProtocolError represents protocol-level errors
type ProtocolError struct {
	Operation string
	Code      int
	Err       error
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("protocol error in %s (code: %d): %v", e.Operation, e.Code, e.Err)
}

func (e *ProtocolError) Unwrap() error {
	return e.Err
}

// ProtobufError represents protobuf-specific errors
type ProtobufError struct {
	Operation string
	EventType string
	Err       error
}

func (e *ProtobufError) Error() string {
	return fmt.Sprintf("protobuf error in %s for event type %s: %v",
		e.Operation, e.EventType, e.Err)
}

func (e *ProtobufError) Unwrap() error {
	return e.Err
}
