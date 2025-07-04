package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// BuiltinToolsOptions configures how built-in tools are registered
type BuiltinToolsOptions struct {
	// SecureMode enables security restrictions on file and HTTP operations
	SecureMode bool
	
	// FileOptions configures file operation security (used when SecureMode is true)
	FileOptions *SecureFileOptions
	
	// HTTPOptions configures HTTP operation security (used when SecureMode is true)
	HTTPOptions *SecureHTTPOptions
}

// RegisterBuiltinTools registers all built-in tools to the given registry.
func RegisterBuiltinTools(registry *Registry) error {
	return RegisterBuiltinToolsWithOptions(registry, nil)
}

// RegisterBuiltinToolsWithOptions registers built-in tools with custom options
func RegisterBuiltinToolsWithOptions(registry *Registry, options *BuiltinToolsOptions) error {
	var tools []*Tool
	
	if options != nil && options.SecureMode {
		// Register secure versions
		tools = []*Tool{
			NewSecureReadFileTool(options.FileOptions),
			NewSecureWriteFileTool(options.FileOptions),
			NewSecureHTTPGetTool(options.HTTPOptions),
			NewSecureHTTPPostTool(options.HTTPOptions),
			NewJSONParseTool(),
			NewJSONFormatTool(),
			NewBase64EncodeTool(),
			NewBase64DecodeTool(),
		}
	} else {
		// Register standard versions
		tools = []*Tool{
			NewReadFileTool(),
			NewWriteFileTool(),
			NewHTTPGetTool(),
			NewHTTPPostTool(),
			NewJSONParseTool(),
			NewJSONFormatTool(),
			NewBase64EncodeTool(),
			NewBase64DecodeTool(),
		}
	}

	for _, tool := range tools {
		if err := registry.Register(tool); err != nil {
			return fmt.Errorf("failed to register tool %q: %w", tool.Name, err)
		}
	}

	return nil
}

// NewReadFileTool creates a tool for reading file contents.
func NewReadFileTool() *Tool {
	return &Tool{
		ID:          "builtin.read_file",
		Name:        "read_file",
		Description: "Read the contents of a file",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"path": {
					Type:        "string",
					Description: "The file path to read",
				},
				"encoding": {
					Type:        "string",
					Description: "File encoding (default: utf-8)",
					Default:     "utf-8",
					Enum:        []interface{}{"utf-8", "ascii", "base64"},
				},
			},
			Required: []string{"path"},
		},
		Executor: &readFileExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout: 5 * time.Second,
		},
	}
}

type readFileExecutor struct{}

func (e *readFileExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("path must be a string")
	}

	encoding, _ := params["encoding"].(string)
	if encoding == "" {
		encoding = "utf-8"
	}

	// Read file
	data, err := os.ReadFile(path)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   err.Error(),
		}, nil
	}

	var content interface{}
	switch encoding {
	case "base64":
		content = base64.StdEncoding.EncodeToString(data)
	default:
		content = string(data)
	}

	return &ToolExecutionResult{
		Success: true,
		Data:    content,
		Metadata: map[string]interface{}{
			"size":     len(data),
			"encoding": encoding,
		},
	}, nil
}

// NewWriteFileTool creates a tool for writing file contents.
func NewWriteFileTool() *Tool {
	return &Tool{
		ID:          "builtin.write_file",
		Name:        "write_file",
		Description: "Write content to a file",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"path": {
					Type:        "string",
					Description: "The file path to write",
				},
				"content": {
					Type:        "string",
					Description: "The content to write",
				},
				"encoding": {
					Type:        "string",
					Description: "Content encoding (default: utf-8)",
					Default:     "utf-8",
					Enum:        []interface{}{"utf-8", "ascii", "base64"},
				},
				"mode": {
					Type:        "string",
					Description: "Write mode: overwrite or append (default: overwrite)",
					Default:     "overwrite",
					Enum:        []interface{}{"overwrite", "append"},
				},
			},
			Required: []string{"path", "content"},
		},
		Executor: &writeFileExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout: 5 * time.Second,
		},
	}
}

type writeFileExecutor struct{}

func (e *writeFileExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("path must be a string")
	}

	content, ok := params["content"].(string)
	if !ok {
		return nil, fmt.Errorf("content must be a string")
	}

	encoding, _ := params["encoding"].(string)
	if encoding == "" {
		encoding = "utf-8"
	}

	mode, _ := params["mode"].(string)
	if mode == "" {
		mode = "overwrite"
	}

	// Prepare data based on encoding
	var data []byte
	switch encoding {
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 content: %w", err)
		}
		data = decoded
	default:
		data = []byte(content)
	}

	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory: %w", err)
	}

	// Write file
	var err error
	if mode == "append" {
		file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return nil, fmt.Errorf("failed to open file: %w", err)
		}
		defer file.Close()
		_, err = file.Write(data)
	} else {
		err = os.WriteFile(path, data, 0644)
	}

	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   err.Error(),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data:    map[string]interface{}{
			"path":         path,
			"bytes_written": len(data),
		},
	}, nil
}

// NewHTTPGetTool creates a tool for making HTTP GET requests.
func NewHTTPGetTool() *Tool {
	return &Tool{
		ID:          "builtin.http_get",
		Name:        "http_get",
		Description: "Make an HTTP GET request",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"url": {
					Type:        "string",
					Description: "The URL to request",
					Format:      "uri",
				},
				"headers": {
					Type:        "object",
					Description: "Optional HTTP headers",
					Properties:  map[string]*Property{},
				},
				"timeout": {
					Type:        "integer",
					Description: "Request timeout in seconds (default: 30)",
					Default:     30,
					Minimum:     &[]float64{1}[0],
					Maximum:     &[]float64{300}[0],
				},
			},
			Required: []string{"url"},
		},
		Executor: &httpGetExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout:   60 * time.Second,
			Retryable: true,
			Cacheable: true,
		},
	}
}

type httpGetExecutor struct{}

func (e *httpGetExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	url, ok := params["url"].(string)
	if !ok {
		return nil, fmt.Errorf("url must be a string")
	}

	timeout := 30
	if t, ok := params["timeout"].(float64); ok {
		timeout = int(t)
	}

	// Create context with timeout that respects parameter timeout
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	// Create HTTP client with no timeout - rely entirely on context
	client := &http.Client{}

	// Create request
	req, err := http.NewRequestWithContext(requestCtx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add headers
	if headers, ok := params["headers"].(map[string]interface{}); ok {
		for key, value := range headers {
			if strValue, ok := value.(string); ok {
				req.Header.Set(key, strValue)
			}
		}
	}

	// Make request
	resp, err := client.Do(req)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   err.Error(),
		}, nil
	}
	defer resp.Body.Close()

	// Read response with memory bounds
	const maxResponseSize = 100 * 1024 * 1024 // 100MB limit
	limitedReader := io.LimitReader(resp.Body, maxResponseSize)
	body, err := io.ReadAll(limitedReader)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return &ToolExecutionResult{
		Success: true,
		Data: map[string]interface{}{
			"status_code": resp.StatusCode,
			"headers":     resp.Header,
			"body":        string(body),
		},
		Metadata: map[string]interface{}{
			"url":           url,
			"content_length": len(body),
		},
	}, nil
}

// NewHTTPPostTool creates a tool for making HTTP POST requests.
func NewHTTPPostTool() *Tool {
	return &Tool{
		ID:          "builtin.http_post",
		Name:        "http_post",
		Description: "Make an HTTP POST request",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"url": {
					Type:        "string",
					Description: "The URL to request",
					Format:      "uri",
				},
				"body": {
					Type:        "string",
					Description: "The request body",
				},
				"content_type": {
					Type:        "string",
					Description: "Content-Type header (default: application/json)",
					Default:     "application/json",
				},
				"headers": {
					Type:        "object",
					Description: "Optional HTTP headers",
					Properties:  map[string]*Property{},
				},
				"timeout": {
					Type:        "integer",
					Description: "Request timeout in seconds (default: 30)",
					Default:     30,
					Minimum:     &[]float64{1}[0],
					Maximum:     &[]float64{300}[0],
				},
			},
			Required: []string{"url"},
		},
		Executor: &httpPostExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout:   60 * time.Second,
			Retryable: true,
		},
	}
}

type httpPostExecutor struct{}

func (e *httpPostExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	url, ok := params["url"].(string)
	if !ok {
		return nil, fmt.Errorf("url must be a string")
	}

	body, _ := params["body"].(string)
	contentType, _ := params["content_type"].(string)
	if contentType == "" {
		contentType = "application/json"
	}

	timeout := 30
	if t, ok := params["timeout"].(float64); ok {
		timeout = int(t)
	}

	// Create context with timeout that respects parameter timeout
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	// Create HTTP client with no timeout - rely entirely on context
	client := &http.Client{}

	// Create request
	req, err := http.NewRequestWithContext(requestCtx, "POST", url, strings.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set content type
	req.Header.Set("Content-Type", contentType)

	// Add headers
	if headers, ok := params["headers"].(map[string]interface{}); ok {
		for key, value := range headers {
			if strValue, ok := value.(string); ok {
				req.Header.Set(key, strValue)
			}
		}
	}

	// Make request
	resp, err := client.Do(req)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   err.Error(),
		}, nil
	}
	defer resp.Body.Close()

	// Read response with memory bounds
	const maxResponseSize = 100 * 1024 * 1024 // 100MB limit
	limitedReader := io.LimitReader(resp.Body, maxResponseSize)
	respBody, err := io.ReadAll(limitedReader)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return &ToolExecutionResult{
		Success: true,
		Data: map[string]interface{}{
			"status_code": resp.StatusCode,
			"headers":     resp.Header,
			"body":        string(respBody),
		},
		Metadata: map[string]interface{}{
			"url":           url,
			"content_length": len(respBody),
		},
	}, nil
}

// NewJSONParseTool creates a tool for parsing JSON.
func NewJSONParseTool() *Tool {
	return &Tool{
		ID:          "builtin.json_parse",
		Name:        "json_parse",
		Description: "Parse JSON string into structured data",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"json": {
					Type:        "string",
					Description: "The JSON string to parse",
				},
			},
			Required: []string{"json"},
		},
		Executor: &jsonParseExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout:   1 * time.Second,
			Cacheable: true,
		},
	}
}

type jsonParseExecutor struct{}

func (e *jsonParseExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	jsonStr, ok := params["json"].(string)
	if !ok {
		return nil, fmt.Errorf("json must be a string")
	}

	var data interface{}
	if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("invalid JSON: %v", err),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data:    data,
	}, nil
}

// NewJSONFormatTool creates a tool for formatting JSON.
func NewJSONFormatTool() *Tool {
	return &Tool{
		ID:          "builtin.json_format",
		Name:        "json_format",
		Description: "Format data as pretty-printed JSON",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"data": {
					Type:        "object",
					Description: "The data to format as JSON",
				},
				"indent": {
					Type:        "integer",
					Description: "Number of spaces for indentation (default: 2)",
					Default:     2,
					Minimum:     &[]float64{0}[0],
					Maximum:     &[]float64{8}[0],
				},
			},
			Required: []string{"data"},
		},
		Executor: &jsonFormatExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout: 1 * time.Second,
		},
	}
}

type jsonFormatExecutor struct{}

func (e *jsonFormatExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	data, ok := params["data"]
	if !ok {
		return nil, fmt.Errorf("data parameter is required")
	}

	indent := 2
	if i, ok := params["indent"].(float64); ok {
		indent = int(i)
	}

	// Create indentation string
	indentStr := strings.Repeat(" ", indent)

	// Format as JSON
	formatted, err := json.MarshalIndent(data, "", indentStr)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to format JSON: %v", err),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data:    string(formatted),
	}, nil
}

// NewBase64EncodeTool creates a tool for base64 encoding.
func NewBase64EncodeTool() *Tool {
	return &Tool{
		ID:          "builtin.base64_encode",
		Name:        "base64_encode",
		Description: "Encode data to base64",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"data": {
					Type:        "string",
					Description: "The data to encode",
				},
			},
			Required: []string{"data"},
		},
		Executor: &base64EncodeExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout: 1 * time.Second,
		},
	}
}

type base64EncodeExecutor struct{}

func (e *base64EncodeExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	data, ok := params["data"].(string)
	if !ok {
		return nil, fmt.Errorf("data must be a string")
	}

	encoded := base64.StdEncoding.EncodeToString([]byte(data))

	return &ToolExecutionResult{
		Success: true,
		Data:    encoded,
	}, nil
}

// NewBase64DecodeTool creates a tool for base64 decoding.
func NewBase64DecodeTool() *Tool {
	return &Tool{
		ID:          "builtin.base64_decode",
		Name:        "base64_decode",
		Description: "Decode base64 data",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"data": {
					Type:        "string",
					Description: "The base64 data to decode",
				},
			},
			Required: []string{"data"},
		},
		Executor: &base64DecodeExecutor{},
		Capabilities: &ToolCapabilities{
			Timeout: 1 * time.Second,
		},
	}
}

type base64DecodeExecutor struct{}

func (e *base64DecodeExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	data, ok := params["data"].(string)
	if !ok {
		return nil, fmt.Errorf("data must be a string")
	}

	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("invalid base64: %v", err),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data:    string(decoded),
	}, nil
}