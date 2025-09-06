package events

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// IDGenerator provides methods for generating unique event IDs
type IDGenerator interface {
	// GenerateRunID generates a unique run ID
	GenerateRunID() string

	// GenerateMessageID generates a unique message ID
	GenerateMessageID() string

	// GenerateToolCallID generates a unique tool call ID
	GenerateToolCallID() string

	// GenerateThreadID generates a unique thread ID
	GenerateThreadID() string

	// GenerateStepID generates a unique step ID
	GenerateStepID() string
}

// DefaultIDGenerator implements IDGenerator using UUID v4
type DefaultIDGenerator struct{}

// NewDefaultIDGenerator creates a new default ID generator
func NewDefaultIDGenerator() *DefaultIDGenerator {
	return &DefaultIDGenerator{}
}

// GenerateRunID generates a unique run ID with "run-" prefix
func (g *DefaultIDGenerator) GenerateRunID() string {
	return fmt.Sprintf("run-%s", uuid.New().String())
}

// GenerateMessageID generates a unique message ID with "msg-" prefix
func (g *DefaultIDGenerator) GenerateMessageID() string {
	return fmt.Sprintf("msg-%s", uuid.New().String())
}

// GenerateToolCallID generates a unique tool call ID with "tool-" prefix
func (g *DefaultIDGenerator) GenerateToolCallID() string {
	return fmt.Sprintf("tool-%s", uuid.New().String())
}

// GenerateThreadID generates a unique thread ID with "thread-" prefix
func (g *DefaultIDGenerator) GenerateThreadID() string {
	return fmt.Sprintf("thread-%s", uuid.New().String())
}

// GenerateStepID generates a unique step ID with "step-" prefix
func (g *DefaultIDGenerator) GenerateStepID() string {
	return fmt.Sprintf("step-%s", uuid.New().String())
}

// TimestampIDGenerator implements IDGenerator using timestamps and short UUIDs
type TimestampIDGenerator struct {
	prefix string
}

// NewTimestampIDGenerator creates a new timestamp-based ID generator
func NewTimestampIDGenerator(prefix string) *TimestampIDGenerator {
	return &TimestampIDGenerator{prefix: prefix}
}

// GenerateRunID generates a timestamp-based run ID
func (g *TimestampIDGenerator) GenerateRunID() string {
	return g.generateTimestampID("run")
}

// GenerateMessageID generates a timestamp-based message ID
func (g *TimestampIDGenerator) GenerateMessageID() string {
	return g.generateTimestampID("msg")
}

// GenerateToolCallID generates a timestamp-based tool call ID
func (g *TimestampIDGenerator) GenerateToolCallID() string {
	return g.generateTimestampID("tool")
}

// GenerateThreadID generates a timestamp-based thread ID
func (g *TimestampIDGenerator) GenerateThreadID() string {
	return g.generateTimestampID("thread")
}

// GenerateStepID generates a timestamp-based step ID
func (g *TimestampIDGenerator) GenerateStepID() string {
	return g.generateTimestampID("step")
}

// generateTimestampID generates a timestamp-based ID with the given type prefix
func (g *TimestampIDGenerator) generateTimestampID(typePrefix string) string {
	timestamp := time.Now().UnixMilli()
	shortUUID := uuid.New().String()[:8]

	if g.prefix != "" {
		return fmt.Sprintf("%s-%s-%d-%s", g.prefix, typePrefix, timestamp, shortUUID)
	}
	return fmt.Sprintf("%s-%d-%s", typePrefix, timestamp, shortUUID)
}

// Global default ID generator instance
var defaultIDGenerator IDGenerator = NewDefaultIDGenerator()

// SetDefaultIDGenerator sets the global default ID generator
func SetDefaultIDGenerator(generator IDGenerator) {
	defaultIDGenerator = generator
}

// GetDefaultIDGenerator returns the current default ID generator
func GetDefaultIDGenerator() IDGenerator {
	return defaultIDGenerator
}

// Convenience functions for generating IDs using the default generator

// GenerateRunID generates a unique run ID using the default generator
func GenerateRunID() string {
	return defaultIDGenerator.GenerateRunID()
}

// GenerateMessageID generates a unique message ID using the default generator
func GenerateMessageID() string {
	return defaultIDGenerator.GenerateMessageID()
}

// GenerateToolCallID generates a unique tool call ID using the default generator
func GenerateToolCallID() string {
	return defaultIDGenerator.GenerateToolCallID()
}

// GenerateThreadID generates a unique thread ID using the default generator
func GenerateThreadID() string {
	return defaultIDGenerator.GenerateThreadID()
}

// GenerateStepID generates a unique step ID using the default generator
func GenerateStepID() string {
	return defaultIDGenerator.GenerateStepID()
}
