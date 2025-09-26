package sse

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

type Config struct {
	Endpoint       string
	APIKey         string
	AuthHeader     string
	AuthScheme     string
	ConnectTimeout time.Duration
	ReadTimeout    time.Duration
	BufferSize     int
	Logger         *logrus.Logger
}

type Client struct {
	config     Config
	httpClient *http.Client
	logger     *logrus.Logger
}

type Frame struct {
	Data      []byte
	Timestamp time.Time
}

type StreamOptions struct {
	Context context.Context
	Payload interface{}
	Headers map[string]string
}

func NewClient(config Config) *Client {
	if config.Logger == nil {
		config.Logger = logrus.New()
	}

	if config.ConnectTimeout == 0 {
		config.ConnectTimeout = 30 * time.Second
	}

	if config.ReadTimeout == 0 {
		config.ReadTimeout = 5 * time.Minute
	}

	if config.BufferSize == 0 {
		config.BufferSize = 100
	}

	transport := &http.Transport{
		DisableCompression:    true,
		ExpectContinueTimeout: 0,
		ResponseHeaderTimeout: config.ConnectTimeout,
		DisableKeepAlives:     false,
		MaxIdleConns:          1,
		MaxIdleConnsPerHost:   1,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
	}

	httpClient := &http.Client{
		Transport: transport,
		Timeout:   0,
	}

	return &Client{
		config:     config,
		httpClient: httpClient,
		logger:     config.Logger,
	}
}

// Stream creates a basic SSE stream without reconnection
func (c *Client) Stream(opts StreamOptions) (<-chan Frame, <-chan error, error) {
	return c.stream(opts)
}

// stream is the internal implementation of basic streaming
func (c *Client) stream(opts StreamOptions) (<-chan Frame, <-chan error, error) {
	if opts.Context == nil {
		opts.Context = context.Background()
	}

	payloadBytes, err := json.Marshal(opts.Payload)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(
		opts.Context,
		http.MethodPost,
		c.config.Endpoint,
		bytes.NewReader(payloadBytes),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Connection", "keep-alive")

	if c.config.APIKey != "" {
		authHeader := c.config.AuthHeader
		if authHeader == "" {
			authHeader = "Authorization"
		}

		// Build the header value based on header type
		if authHeader == "Authorization" {
			// Use scheme (Bearer by default) for Authorization header
			scheme := "Bearer"
			if c.config.AuthScheme != "" {
				scheme = c.config.AuthScheme
			}
			req.Header.Set(authHeader, scheme+" "+c.config.APIKey)
		} else {
			// For custom headers like X-API-Key, use the key directly
			req.Header.Set(authHeader, c.config.APIKey)
		}
	}

	for key, value := range opts.Headers {
		req.Header.Set(key, value)
	}

	if c.logger != nil {
		c.logger.WithFields(logrus.Fields{
			"endpoint": c.config.Endpoint,
			"method":   req.Method,
			"headers":  req.Header,
		}).Debug("Initiating SSE connection")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to execute request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("unexpected status code %d: %s", resp.StatusCode, string(body))
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "text/event-stream") {
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("unexpected content-type: %s", contentType)
	}

	if c.logger != nil {
		c.logger.WithFields(logrus.Fields{
			"status":       resp.StatusCode,
			"content_type": contentType,
		}).Info("SSE connection established")
	}

	frames := make(chan Frame, c.config.BufferSize)
	errors := make(chan error, 1)

	go c.readStream(opts.Context, resp, frames, errors)

	return frames, errors, nil
}

func (c *Client) readStream(ctx context.Context, resp *http.Response, frames chan<- Frame, errors chan<- error) {
	defer func() {
		_ = resp.Body.Close()
		close(frames)
		close(errors)
		if c.logger != nil {
			c.logger.Info("SSE connection closed")
		}
	}()

	reader := bufio.NewReader(resp.Body)
	var buffer bytes.Buffer
	var frameCount int64
	var byteCount int64
	startTime := time.Now()

	// Create a channel for read results
	type readResult struct {
		line []byte
		err  error
	}
	readCh := make(chan readResult)

	for {
		select {
		case <-ctx.Done():
			if c.logger != nil {
				c.logger.WithField("reason", "context cancelled").Debug("Stopping SSE stream")
			}
			return
		default:
		}

		// Start async read
		go func() {
			line, err := reader.ReadBytes('\n')
			select {
			case readCh <- readResult{line: line, err: err}:
			case <-ctx.Done():
			}
		}()

		// Wait for read result with timeout
		var result readResult
		if c.config.ReadTimeout > 0 {
			select {
			case result = <-readCh:
				// Got result
			case <-time.After(c.config.ReadTimeout):
				// Timeout occurred
				select {
				case errors <- fmt.Errorf("read timeout after %v", c.config.ReadTimeout):
				case <-ctx.Done():
				}
				return
			case <-ctx.Done():
				return
			}
		} else {
			select {
			case result = <-readCh:
				// Got result
			case <-ctx.Done():
				return
			}
		}

		if result.err != nil {
			if result.err == io.EOF {
				if c.logger != nil {
					c.logger.WithFields(logrus.Fields{
						"frames":   frameCount,
						"bytes":    byteCount,
						"duration": time.Since(startTime),
					}).Info("SSE stream ended (EOF)")
				}
				return
			}
			select {
			case errors <- fmt.Errorf("read error: %w", result.err):
			case <-ctx.Done():
			}
			return
		}

		line := result.line

		byteCount += int64(len(line))
		line = bytes.TrimSuffix(line, []byte("\n"))
		line = bytes.TrimSuffix(line, []byte("\r"))

		if len(line) == 0 {
			if buffer.Len() > 0 {
				frame := Frame{
					Data:      make([]byte, buffer.Len()),
					Timestamp: time.Now(),
				}
				copy(frame.Data, buffer.Bytes())
				buffer.Reset()

				select {
				case frames <- frame:
					frameCount++
					if frameCount%100 == 0 && c.logger != nil {
						c.logger.WithFields(logrus.Fields{
							"frames": frameCount,
							"bytes":  byteCount,
						}).Debug("SSE stream progress")
					}
				case <-ctx.Done():
					return
				}
			}
			continue
		}

		if bytes.HasPrefix(line, []byte("data: ")) {
			data := bytes.TrimPrefix(line, []byte("data: "))
			if buffer.Len() > 0 {
				buffer.WriteByte('\n')
			}
			buffer.Write(data)
		}
	}
}

func (c *Client) Close() error {
	c.httpClient.CloseIdleConnections()
	return nil
}
