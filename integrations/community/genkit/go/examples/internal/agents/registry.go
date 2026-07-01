package agents

import (
	"context"
	"sync"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// Message represents a chat message in the conversation
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// RunAgentInput represents the input for running an agent
type RunAgentInput struct {
	ThreadID string    `json:"threadId"`
	RunID    string    `json:"runId"`
	Messages []Message `json:"messages"`
	State    any       `json:"state,omitempty"`
}

// Agent defines the interface for all agents
type Agent interface {
	// Name returns the agent's name
	Name() string

	// Description returns a brief description of the agent
	Description() string

	// Run executes the agent with the given input and streams events to the channel
	Run(ctx context.Context, input RunAgentInput, eventsCh chan<- events.Event) error
}

// Registry manages registered agents
type Registry struct {
	mu     sync.RWMutex
	agents map[string]Agent
}

// NewRegistry creates a new agent registry
func NewRegistry() *Registry {
	return &Registry{
		agents: make(map[string]Agent),
	}
}

// Register adds an agent to the registry
func (r *Registry) Register(agent Agent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agents[agent.Name()] = agent
}

// Get retrieves an agent by name
func (r *Registry) Get(name string) (Agent, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	agent, ok := r.agents[name]
	return agent, ok
}

// List returns all registered agents
func (r *Registry) List() []Agent {
	r.mu.RLock()
	defer r.mu.RUnlock()
	agents := make([]Agent, 0, len(r.agents))
	for _, agent := range r.agents {
		agents = append(agents, agent)
	}
	return agents
}

// Names returns the names of all registered agents
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.agents))
	for name := range r.agents {
		names = append(names, name)
	}
	return names
}
