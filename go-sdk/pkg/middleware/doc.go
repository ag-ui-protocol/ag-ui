// Package middleware provides middleware and interceptor system for the AG-UI protocol.
//
// This package implements a flexible middleware system that allows developers
// to intercept and modify events as they flow through the AG-UI system.
// Middleware can be used for authentication, logging, metrics, rate limiting,
// validation, and other cross-cutting concerns.
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/middleware"
//
//	// Create logging middleware
//	logger := middleware.NewLogging()
//
//	// Create authentication middleware
//	auth := middleware.NewAuth(authConfig)
//
//	// Chain middleware
//	chain := middleware.Chain(logger, auth)
//
//	// Apply to server
//	server.Use(chain)
package middleware
