package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/mcp"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/routes"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/cors"
	"github.com/gofiber/fiber/v3/middleware/requestid"
	"github.com/sirupsen/logrus"
)

func newErrorHandler() fiber.ErrorHandler {
	return func(c fiber.Ctx, err error) error {
		code := fiber.StatusInternalServerError
		var ferr *fiber.Error
		if errors.As(err, &ferr) {
			code = ferr.Code
		}

		entry := logrus.NewEntry(logrus.StandardLogger())
		entry.WithFields(logrus.Fields{
			"error":  err.Error(),
			"status": code,
		}).Error("Request error")

		return c.Status(code).JSON(fiber.Map{
			"error":   true,
			"message": err.Error(),
		})
	}
}

func registerRoutes(app *fiber.App, cfg *config.Config) {

	// Basic info route
	app.Get("/", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"message": "AG-UI Go Example Server is running!",
			"path":    c.Path(),
			"method":  c.Method(),
			"headers": c.GetReqHeaders(),
		})
	})

	if !cfg.EnableSSE {
		return
	}

	// Feature routes
	app.Post("/agentic", routes.AgenticHandler(cfg))
}

func logConfig(logger *logrus.Logger, cfg *config.Config) {
	logger.WithFields(logrus.Fields{
		"host":                  cfg.Host,
		"port":                  cfg.Port,
		"log_level":             cfg.LogLevel,
		"enable_sse":            cfg.EnableSSE,
		"read_timeout":          cfg.ReadTimeout,
		"write_timeout":         cfg.WriteTimeout,
		"sse_keepalive":         cfg.SSEKeepAlive,
		"cors_enabled":          cfg.CORSEnabled,
		"streaming_chunk_delay": cfg.StreamingChunkDelay,
	}).Info("Server configuration loaded")
}

func createApp(cfg *config.Config, logger *logrus.Logger) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:      "AG-UI Example Server",
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		ErrorHandler: newErrorHandler(),
	})

	// Middleware
	app.Use(requestid.New())

	// CORS
	if cfg.CORSEnabled {
		app.Use(cors.New(cors.Config{
			AllowOrigins:     cfg.CORSAllowedOrigins,
			AllowMethods:     []string{"GET", "POST", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "X-Request-ID"},
			AllowCredentials: false,
		}))
	}

	// Content negotiation
	//app.Use(encoding.ContentNegotiationMiddleware(encoding.ContentNegotiationConfig{
	//	DefaultContentType: "application/json",
	//	SupportedTypes:     []string{"application/json", "application/vnd.ag-ui+json"},
	//	EnableLogging:      cfg.LogLevel == "debug",
	//}))

	// Routes
	registerRoutes(app, cfg)

	return app
}

func main() {
	// Load configuration with proper precedence: flags > env > defaults
	cfg, err := config.LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load configuration: %v\n", err)
		os.Exit(1)
	}

	// Set up structured logging with logrus
	logger := logrus.New()

	// Log the effective configuration
	logConfig(logger, cfg)

	app := createApp(cfg, logger)

	// Start server in a goroutine
	serverAddr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	go func() {
		logger.WithField("address", serverAddr).Info("Starting server")
		if err := app.Listen(serverAddr); err != nil {
			logger.WithError(err).Error("Server failed to start")
			os.Exit(1)
		}
	}()

	logger.WithField("address", serverAddr).Info("Server started successfully")

	// Start mcp in a goroutine
	mcpServer, err := mcp.NewServer(mcp.DefaultPort)
	if err != nil {
		logger.WithError(err).Error("Failed to create MCP server")
		os.Exit(1)
	}
	go func() {
		err := mcpServer.Start()
		if err != nil {
			logger.WithError(err).Error("MCP server failed to start")
			os.Exit(1)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down server...")

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = mcpServer.Shutdown(ctx)
	if err != nil {
		logger.WithError(err).Error("MCP server shutdown error")
	}

	if err = app.ShutdownWithContext(ctx); err != nil {
		logger.WithError(err).Error("Server shutdown error")
		os.Exit(1)
	}

	logger.Info("Server shutdown complete")
}
