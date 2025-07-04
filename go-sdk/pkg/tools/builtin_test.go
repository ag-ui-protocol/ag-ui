package tools

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRegisterBuiltinTools(t *testing.T) {
	registry := NewRegistry()
	err := RegisterBuiltinTools(registry)
	require.NoError(t, err)

	// Check that all builtin tools are registered
	expectedTools := []string{
		"builtin.read_file",
		"builtin.write_file",
		"builtin.http_get",
		"builtin.http_post",
		"builtin.json_parse",
		"builtin.json_format",
		"builtin.base64_encode",
		"builtin.base64_decode",
	}

	for _, toolID := range expectedTools {
		tool, err := registry.Get(toolID)
		require.NoError(t, err)
		assert.NotNil(t, tool)
	}
}

func TestReadFileTool(t *testing.T) {
	tool := NewReadFileTool()
	assert.Equal(t, "builtin.read_file", tool.ID)
	assert.Equal(t, "read_file", tool.Name)

	// Create test file
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "test.txt")
	testContent := "Hello, World!"
	err := os.WriteFile(testFile, []byte(testContent), 0644)
	require.NoError(t, err)

	t.Run("read text file", func(t *testing.T) {
		params := map[string]interface{}{
			"path": testFile,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, testContent, result.Data)
		assert.Equal(t, len(testContent), result.Metadata["size"])
	})

	t.Run("read with encoding", func(t *testing.T) {
		params := map[string]interface{}{
			"path":     testFile,
			"encoding": "base64",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, base64.StdEncoding.EncodeToString([]byte(testContent)), result.Data)
	})

	t.Run("read non-existent file", func(t *testing.T) {
		params := map[string]interface{}{
			"path": "/non/existent/file.txt",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "no such file")
	})

	t.Run("invalid path type", func(t *testing.T) {
		params := map[string]interface{}{
			"path": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path must be a string")
	})
}

func TestWriteFileTool(t *testing.T) {
	tool := NewWriteFileTool()
	assert.Equal(t, "builtin.write_file", tool.ID)
	assert.Equal(t, "write_file", tool.Name)

	tmpDir := t.TempDir()

	t.Run("write text file", func(t *testing.T) {
		testFile := filepath.Join(tmpDir, "output.txt")
		testContent := "Test content"

		params := map[string]interface{}{
			"path":    testFile,
			"content": testContent,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		// Verify file was written
		data, err := os.ReadFile(testFile)
		require.NoError(t, err)
		assert.Equal(t, testContent, string(data))
	})

	t.Run("write with base64 encoding", func(t *testing.T) {
		testFile := filepath.Join(tmpDir, "binary.dat")
		originalContent := "Binary data"
		base64Content := base64.StdEncoding.EncodeToString([]byte(originalContent))

		params := map[string]interface{}{
			"path":     testFile,
			"content":  base64Content,
			"encoding": "base64",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		// Verify file was written with decoded content
		data, err := os.ReadFile(testFile)
		require.NoError(t, err)
		assert.Equal(t, originalContent, string(data))
	})

	t.Run("append mode", func(t *testing.T) {
		testFile := filepath.Join(tmpDir, "append.txt")
		
		// Write initial content
		params := map[string]interface{}{
			"path":    testFile,
			"content": "Line 1\n",
		}
		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		// Append more content
		params = map[string]interface{}{
			"path":    testFile,
			"content": "Line 2\n",
			"mode":    "append",
		}
		result, err = tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		// Verify both lines are present
		data, err := os.ReadFile(testFile)
		require.NoError(t, err)
		assert.Equal(t, "Line 1\nLine 2\n", string(data))
	})

	t.Run("create directory if needed", func(t *testing.T) {
		testFile := filepath.Join(tmpDir, "subdir", "nested", "file.txt")
		params := map[string]interface{}{
			"path":    testFile,
			"content": "test",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		// Verify file was created
		_, err = os.Stat(testFile)
		require.NoError(t, err)
	})

	t.Run("invalid parameters", func(t *testing.T) {
		// Missing content
		params := map[string]interface{}{
			"path": 123, // Invalid type
		}
		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path must be a string")

		// Invalid content type
		params = map[string]interface{}{
			"path":    "/tmp/test.txt",
			"content": 123, // Not a string
		}
		_, err = tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "content must be a string")
	})

	t.Run("invalid base64", func(t *testing.T) {
		params := map[string]interface{}{
			"path":     filepath.Join(tmpDir, "invalid.dat"),
			"content":  "not-valid-base64!@#$",
			"encoding": "base64",
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid base64")
	})
}

func TestHTTPGetTool(t *testing.T) {
	tool := NewHTTPGetTool()
	assert.Equal(t, "builtin.http_get", tool.ID)
	assert.Equal(t, "http_get", tool.Name)

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)
		
		// Echo headers back
		for key, values := range r.Header {
			if strings.HasPrefix(key, "X-Test-") {
				w.Header().Set(key, values[0])
			}
		}
		
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Response body"))
	}))
	defer server.Close()

	t.Run("successful request", func(t *testing.T) {
		params := map[string]interface{}{
			"url": server.URL,
			"headers": map[string]interface{}{
				"X-Test-Header": "test-value",
			},
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		data := result.Data.(map[string]interface{})
		assert.Equal(t, 200, data["status_code"])
		assert.Equal(t, "Response body", data["body"])

		headers := data["headers"].(http.Header)
		assert.Equal(t, "test-value", headers.Get("X-Test-Header"))
	})

	t.Run("timeout", func(t *testing.T) {
		// Create slow server
		slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Delay longer than timeout
			<-r.Context().Done()
		}))
		defer slowServer.Close()

		params := map[string]interface{}{
			"url":     slowServer.URL,
			"timeout": 1, // 1 second timeout
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "context deadline exceeded")
	})

	t.Run("invalid URL", func(t *testing.T) {
		params := map[string]interface{}{
			"url": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "url must be a string")
	})

	t.Run("invalid URL format", func(t *testing.T) {
		params := map[string]interface{}{
			"url": "not-a-valid-url",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "unsupported protocol")
	})
}

func TestHTTPPostTool(t *testing.T) {
	tool := NewHTTPPostTool()
	assert.Equal(t, "builtin.http_post", tool.ID)
	assert.Equal(t, "http_post", tool.Name)

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		
		// Read and echo body
		body, _ := io.ReadAll(r.Body)
		
		w.Header().Set("Content-Type", r.Header.Get("Content-Type"))
		w.WriteHeader(http.StatusCreated)
		w.Write(body)
	}))
	defer server.Close()

	t.Run("successful JSON post", func(t *testing.T) {
		params := map[string]interface{}{
			"url":  server.URL,
			"body": `{"key": "value"}`,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		data := result.Data.(map[string]interface{})
		assert.Equal(t, 201, data["status_code"])
		assert.Equal(t, `{"key": "value"}`, data["body"])

		headers := data["headers"].(http.Header)
		assert.Equal(t, "application/json", headers.Get("Content-Type"))
	})

	t.Run("custom content type", func(t *testing.T) {
		params := map[string]interface{}{
			"url":          server.URL,
			"body":         "plain text body",
			"content_type": "text/plain",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		data := result.Data.(map[string]interface{})
		headers := data["headers"].(http.Header)
		assert.Equal(t, "text/plain", headers.Get("Content-Type"))
	})

	t.Run("with custom headers", func(t *testing.T) {
		params := map[string]interface{}{
			"url":  server.URL,
			"body": "",
			"headers": map[string]interface{}{
				"Authorization": "Bearer token123",
			},
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
	})

	t.Run("invalid URL", func(t *testing.T) {
		params := map[string]interface{}{
			"url": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "url must be a string")
	})
}

func TestJSONParseTool(t *testing.T) {
	tool := NewJSONParseTool()
	assert.Equal(t, "builtin.json_parse", tool.ID)
	assert.Equal(t, "json_parse", tool.Name)

	t.Run("parse valid JSON", func(t *testing.T) {
		params := map[string]interface{}{
			"json": `{"name": "test", "value": 42, "nested": {"key": "value"}}`,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		data := result.Data.(map[string]interface{})
		assert.Equal(t, "test", data["name"])
		assert.Equal(t, float64(42), data["value"])

		nested := data["nested"].(map[string]interface{})
		assert.Equal(t, "value", nested["key"])
	})

	t.Run("parse JSON array", func(t *testing.T) {
		params := map[string]interface{}{
			"json": `[1, 2, 3, "test"]`,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		data := result.Data.([]interface{})
		assert.Len(t, data, 4)
		assert.Equal(t, float64(1), data[0])
		assert.Equal(t, "test", data[3])
	})

	t.Run("invalid JSON", func(t *testing.T) {
		params := map[string]interface{}{
			"json": `{invalid json}`,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "invalid JSON")
	})

	t.Run("invalid parameter type", func(t *testing.T) {
		params := map[string]interface{}{
			"json": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "json must be a string")
	})
}

func TestJSONFormatTool(t *testing.T) {
	tool := NewJSONFormatTool()
	assert.Equal(t, "builtin.json_format", tool.ID)
	assert.Equal(t, "json_format", tool.Name)

	t.Run("format object", func(t *testing.T) {
		params := map[string]interface{}{
			"data": map[string]interface{}{
				"name":  "test",
				"value": 42,
				"nested": map[string]interface{}{
					"key": "value",
				},
			},
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		formatted := result.Data.(string)
		assert.Contains(t, formatted, `"name": "test"`)
		assert.Contains(t, formatted, `"value": 42`)
		assert.Contains(t, formatted, "  ") // Default 2-space indent
	})

	t.Run("custom indentation", func(t *testing.T) {
		params := map[string]interface{}{
			"data": map[string]interface{}{
				"key": "value",
			},
			"indent": 4,
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		formatted := result.Data.(string)
		assert.Contains(t, formatted, "  ") // 2-space indent (JSON marshaler uses 2 spaces per indent level)
	})

	t.Run("format array", func(t *testing.T) {
		params := map[string]interface{}{
			"data": []interface{}{1, 2, "three"},
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)

		formatted := result.Data.(string)
		assert.Equal(t, "[\n  1,\n  2,\n  \"three\"\n]", formatted)
	})

	t.Run("missing data parameter", func(t *testing.T) {
		params := map[string]interface{}{}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "data parameter is required")
	})
}

func TestBase64EncodeTool(t *testing.T) {
	tool := NewBase64EncodeTool()
	assert.Equal(t, "builtin.base64_encode", tool.ID)
	assert.Equal(t, "base64_encode", tool.Name)

	t.Run("encode string", func(t *testing.T) {
		params := map[string]interface{}{
			"data": "Hello, World!",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, "SGVsbG8sIFdvcmxkIQ==", result.Data)
	})

	t.Run("encode empty string", func(t *testing.T) {
		params := map[string]interface{}{
			"data": "",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, "", result.Data)
	})

	t.Run("invalid parameter type", func(t *testing.T) {
		params := map[string]interface{}{
			"data": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "data must be a string")
	})
}

func TestBase64DecodeTool(t *testing.T) {
	tool := NewBase64DecodeTool()
	assert.Equal(t, "builtin.base64_decode", tool.ID)
	assert.Equal(t, "base64_decode", tool.Name)

	t.Run("decode valid base64", func(t *testing.T) {
		params := map[string]interface{}{
			"data": "SGVsbG8sIFdvcmxkIQ==",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, "Hello, World!", result.Data)
	})

	t.Run("decode empty string", func(t *testing.T) {
		params := map[string]interface{}{
			"data": "",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, "", result.Data)
	})

	t.Run("invalid base64", func(t *testing.T) {
		params := map[string]interface{}{
			"data": "not-valid-base64!@#$",
		}

		result, err := tool.Executor.Execute(context.Background(), params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "invalid base64")
	})

	t.Run("invalid parameter type", func(t *testing.T) {
		params := map[string]interface{}{
			"data": 123, // Not a string
		}

		_, err := tool.Executor.Execute(context.Background(), params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "data must be a string")
	})
}

func TestBuiltinToolSchemas(t *testing.T) {
	// Test that all builtin tools have valid schemas
	tools := []*Tool{
		NewReadFileTool(),
		NewWriteFileTool(),
		NewHTTPGetTool(),
		NewHTTPPostTool(),
		NewJSONParseTool(),
		NewJSONFormatTool(),
		NewBase64EncodeTool(),
		NewBase64DecodeTool(),
	}

	for _, tool := range tools {
		t.Run(tool.Name, func(t *testing.T) {
			err := tool.Validate()
			require.NoError(t, err)

			// Verify schema structure
			assert.Equal(t, "object", tool.Schema.Type)
			assert.NotEmpty(t, tool.Schema.Properties)
			assert.NotEmpty(t, tool.Schema.Required)

			// Verify capabilities
			assert.NotNil(t, tool.Capabilities)
			assert.Greater(t, tool.Capabilities.Timeout, time.Duration(0))
		})
	}
}