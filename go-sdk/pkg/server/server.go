package server

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/ag-ui/go-sdk/pkg/core"
)

// Server represents an AG-UI server that can host multiple agents.
type Server struct {
	config *Config
	agents map[string]core.Agent
	mu     sync.RWMutex

	// TODO: Add transport handlers, middleware stack, and connection management
}

// Config contains configuration options for the server.
type Config struct {
	// Address is the server listen address (e.g., ":8080")
	Address string

	// TODO: Add TLS configuration, CORS settings, middleware options, etc.
}

// New creates a new AG-UI server with the specified configuration.
func New(config Config) *Server {
	return &Server{
		config: &config,
		agents: make(map[string]core.Agent),
	}
}

// RegisterAgent registers an agent with the server under the specified name.
func (s *Server) RegisterAgent(name string, agent core.Agent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents[name] = agent
}

// UnregisterAgent removes an agent from the server.
func (s *Server) UnregisterAgent(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.agents, name)
}

// GetAgent retrieves a registered agent by name.
func (s *Server) GetAgent(name string) (core.Agent, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	agent, exists := s.agents[name]
	return agent, exists
}

// ListenAndServe starts the server and listens for incoming connections.
func (s *Server) ListenAndServe() error {
	// TODO: Implement HTTP server setup with AG-UI protocol handlers
	http.HandleFunc("/ag-ui", s.handleAGUI)

	fmt.Printf("Starting AG-UI server on %s\n", s.config.Address)
	return http.ListenAndServe(s.config.Address, nil)
}

// handleAGUI handles incoming AG-UI protocol requests.
func (s *Server) handleAGUI(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement protocol handling, event routing, and response generation
	w.WriteHeader(http.StatusNotImplemented)
	w.Write([]byte("AG-UI protocol handler not implemented"))
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	// TODO: Implement graceful shutdown
	return fmt.Errorf("not implemented")
}
