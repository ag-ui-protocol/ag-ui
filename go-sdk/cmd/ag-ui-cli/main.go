// Package main provides the AG-UI CLI tool for development and management.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("AG-UI CLI v0.1.0")
	fmt.Println("A command-line tool for AG-UI development and management.")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  ag-ui-cli [command]")
	fmt.Println()
	fmt.Println("Available Commands:")
	fmt.Println("  init      Initialize a new AG-UI project")
	fmt.Println("  generate  Generate code from protocol definitions")
	fmt.Println("  validate  Validate AG-UI event schemas")
	fmt.Println("  serve     Start a development server")
	fmt.Println("  help      Show help information")
	fmt.Println()
	fmt.Println("Run 'ag-ui-cli help [command]' for more information about a command.")

	// TODO: Implement full CLI with command parsing and subcommands
	if len(os.Args) > 1 {
		fmt.Printf("Command '%s' not implemented yet.\n", os.Args[1])
		os.Exit(1)
	}
}
