package client_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ag-ui/go-sdk/pkg/client"
	"github.com/ag-ui/go-sdk/pkg/core"
)

func TestNew(t *testing.T) {
	tests := []struct {
		name    string
		config  client.Config
		wantErr bool
		errType any
	}{
		{
			name: "valid config",
			config: client.Config{
				BaseURL: "http://localhost:8080",
			},
			wantErr: false,
		},
		{
			name: "valid config with https",
			config: client.Config{
				BaseURL: "https://api.example.com",
			},
			wantErr: false,
		},
		{
			name: "empty URL",
			config: client.Config{
				BaseURL: "",
			},
			wantErr: true,
			errType: &core.ConfigError{},
		},
		{
			name: "invalid URL scheme",
			config: client.Config{
				BaseURL: "://invalid-scheme",
			},
			wantErr: true,
			errType: &core.ConfigError{},
		},
		{
			name: "malformed URL",
			config: client.Config{
				BaseURL: "http://[::1:80",
			},
			wantErr: true,
			errType: &core.ConfigError{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := client.New(tt.config)
			if (err != nil) != tt.wantErr {
				t.Errorf("New() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
				verifyTestError(t, err, tt.errType, "BaseURL")
				return
			}
			
			if client == nil {
				t.Error("New() returned nil client with no error")
				return
			}
			// Note: baseURL is not exported, so we can't test it directly
			// This is acceptable as it's an implementation detail
		})
	}
}

func TestClient_SendEvent(t *testing.T) {
	// Create a valid client
	client, err := client.New(client.Config{BaseURL: "http://localhost:8080"})
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	// Create a test event
	testEvent := core.NewEvent("test-123", "message", core.MessageData{
		Content: "test message",
		Sender:  "user",
	})

	tests := []struct {
		name      string
		agentName string
		event     any
		wantErr   bool
		errType   any
	}{
		{
			name:      "valid request",
			agentName: "test-agent",
			event:     testEvent,
			wantErr:   true, // Should error with ErrNotImplemented
		},
		{
			name:      "empty agent name",
			agentName: "",
			event:     testEvent,
			wantErr:   true,
			errType:   &core.ConfigError{},
		},
		{
			name:      "nil event",
			agentName: "test-agent",
			event:     nil,
			wantErr:   true,
			errType:   &core.ConfigError{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			responses, err := client.SendEvent(ctx, tt.agentName, tt.event)

			if (err != nil) != tt.wantErr {
				t.Errorf("SendEvent() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
				if responses != nil {
					t.Error("SendEvent() should return nil responses on error")
				}
				verifyErrorOrNotImplemented(t, err, tt.errType)
			}
		})
	}
}

func TestClient_Stream(t *testing.T) {
	// Create a valid client
	client, err := client.New(client.Config{BaseURL: "http://localhost:8080"})
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	tests := []struct {
		name      string
		agentName string
		wantErr   bool
		errType   any
	}{
		{
			name:      "valid request",
			agentName: "test-agent",
			wantErr:   true, // Should error with ErrNotImplemented
		},
		{
			name:      "empty agent name",
			agentName: "",
			wantErr:   true,
			errType:   &core.ConfigError{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			stream, err := client.Stream(ctx, tt.agentName)

			if (err != nil) != tt.wantErr {
				t.Errorf("Stream() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
				if stream != nil {
					t.Error("Stream() should return nil stream on error")
				}
				if tt.errType != nil {
					verifyTestError(t, err, tt.errType, "agentName")
				} else {
					verifyNotImplementedError(t, err)
				}
			}
		})
	}
}

func TestClient_Close(t *testing.T) {
	client, err := client.New(client.Config{BaseURL: "http://localhost:8080"})
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	// Currently Close() is a no-op, so it should not error
	err = client.Close()
	if err != nil {
		t.Errorf("Close() error = %v, want nil", err)
	}
}

// Helper functions to reduce complexity

func verifyTestError(t *testing.T, err error, expectedType any, expectedField string) {
	t.Helper()
	if expectedType == nil {
		return
	}
	
	var configErr *core.ConfigError
	if !errors.As(err, &configErr) {
		t.Errorf("Expected error type %T, got %T", expectedType, err)
		return
	}
	
	if expectedField != "" && configErr.Field != expectedField {
		t.Errorf("Expected error field %q, got %v", expectedField, configErr.Field)
	}
}

func verifyNotImplementedError(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, core.ErrNotImplemented) {
		t.Errorf("Expected ErrNotImplemented, got %v", err)
	}
}

func verifyErrorOrNotImplemented(t *testing.T, err error, errType any) {
	t.Helper()
	if errType != nil {
		verifyTestError(t, err, errType, "")
	} else {
		verifyNotImplementedError(t, err)
	}
}

func TestConfigError_Unwrap(t *testing.T) {
	_, err := client.New(client.Config{BaseURL: ""})
	if err == nil {
		t.Fatal("Expected error for empty BaseURL")
	}

	var configErr *core.ConfigError
	if !errors.As(err, &configErr) {
		t.Fatalf("Expected ConfigError, got %T", err)
	}

	// Test error unwrapping
	unwrapped := configErr.Unwrap()
	if unwrapped == nil {
		t.Error("ConfigError.Unwrap() should return underlying error")
	}

	// Test error message contains useful information
	errMsg := configErr.Error()
	if !strings.Contains(errMsg, "BaseURL") {
		t.Errorf("Error message should contain field name, got: %v", errMsg)
	}
}
