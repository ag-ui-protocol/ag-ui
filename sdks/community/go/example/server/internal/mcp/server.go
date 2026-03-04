package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const DefaultPort = 3217

type Server struct {
	server *server.StreamableHTTPServer
	port   int
}

func NewServer(port int) (*Server, error) {
	// Create a new MCP server
	s := server.NewMCPServer(
		"Demo 🚀",
		"1.0.0",
		server.WithToolCapabilities(false),
	)

	// Add tool
	tool := mcp.NewTool("provide_language_options",
		mcp.WithDescription("Provide a list of programming languages to choose from"),
		mcp.WithString("option1",
			mcp.Required(),
			mcp.Description("Name of the first programming language option"),
		),
		mcp.WithString("option2",
			mcp.Required(),
			mcp.Description("Name of the second programming language option"),
		),
		mcp.WithString("option3",
			mcp.Required(),
			mcp.Description("Name of the third programming language option"),
		),
		mcp.WithString("option4",
			mcp.Required(),
			mcp.Description("Name of the fourth programming language option"),
		),
	)

	// Add tool handler
	s.AddTool(tool, languageChoiceHandler)

	streamableServer := server.NewStreamableHTTPServer(s)

	return &Server{
		server: streamableServer,
		port:   port,
	}, nil
}

func (s *Server) Start() error {
	portString := fmt.Sprintf(":%d", s.port)
	return s.server.Start(portString)
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.server.Shutdown(ctx)
}

type LanguageOptions struct {
	Option1 string
	Option2 string
	Option3 string
	Option4 string
}

func languageChoiceHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	optionOne, err := request.RequireString("option1")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	optionTwo, err := request.RequireString("option2")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	optionThree, err := request.RequireString("option3")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	optionFour, err := request.RequireString("option4")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	// Marshal the struct to a JSON byte slice
	jsonData, err := json.Marshal(LanguageOptions{
		Option1: optionOne,
		Option2: optionTwo,
		Option3: optionThree,
		Option4: optionFour,
	})
	if err != nil {
		fmt.Println("Error marshaling JSON:", err)
		return nil, err
	}

	return mcp.NewToolResultText(string(jsonData)), nil
}
