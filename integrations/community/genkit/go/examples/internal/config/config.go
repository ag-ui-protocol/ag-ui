package config

import (
	"flag"
	"os"
	"strconv"
)

// Config holds the server configuration
type Config struct {
	Host         string
	Port         int
	MockMode     bool
	GenkitAPIKey string
	GenkitModel  string
}

// DefaultConfig returns the default configuration
func DefaultConfig() *Config {
	return &Config{
		Host:        "0.0.0.0",
		Port:        8000,
		MockMode:    false,
		GenkitModel: "googleai/gemini-2.0-flash",
	}
}

// Load loads configuration from environment variables and command line flags
func Load() *Config {
	cfg := DefaultConfig()

	// Load from environment variables first
	if host := os.Getenv("GENKIT_HOST"); host != "" {
		cfg.Host = host
	}
	if port := os.Getenv("GENKIT_PORT"); port != "" {
		if p, err := strconv.Atoi(port); err == nil {
			cfg.Port = p
		}
	}
	if mockMode := os.Getenv("GENKIT_MOCK_MODE"); mockMode != "" {
		cfg.MockMode = mockMode == "true" || mockMode == "1"
	}
	if apiKey := os.Getenv("GENKIT_API_KEY"); apiKey != "" {
		cfg.GenkitAPIKey = apiKey
	}
	// Also check GOOGLE_API_KEY which is commonly used
	if apiKey := os.Getenv("GOOGLE_API_KEY"); apiKey != "" && cfg.GenkitAPIKey == "" {
		cfg.GenkitAPIKey = apiKey
	}
	if model := os.Getenv("GENKIT_MODEL"); model != "" {
		cfg.GenkitModel = model
	}

	// Parse command line flags (override env vars)
	flag.StringVar(&cfg.Host, "host", cfg.Host, "Server host address")
	flag.IntVar(&cfg.Port, "port", cfg.Port, "Server port")
	flag.BoolVar(&cfg.MockMode, "mock-mode", cfg.MockMode, "Enable mock mode (no API key required)")
	flag.StringVar(&cfg.GenkitAPIKey, "api-key", cfg.GenkitAPIKey, "Genkit/Google API key")
	flag.StringVar(&cfg.GenkitModel, "model", cfg.GenkitModel, "Genkit model to use")
	flag.Parse()

	return cfg
}

// Validate validates the configuration
func (c *Config) Validate() error {
	// In mock mode, API key is not required
	if c.MockMode {
		return nil
	}
	// In real mode, we don't require API key upfront - let Genkit handle it
	return nil
}
