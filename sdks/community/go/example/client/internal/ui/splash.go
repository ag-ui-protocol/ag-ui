package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var (
	splashStyle = lipgloss.NewStyle().
		Foreground(primaryColor).
		Bold(true).
		Align(lipgloss.Center)

	splashSubtitleStyle = lipgloss.NewStyle().
		Foreground(mutedTextColor).
		Align(lipgloss.Center).
		MarginTop(1)
)

func getSplashScreen(width, height int) string {
	logo := `
  _____ _           _   
 / ____| |         | |  
| |    | |__   __ _| |_ 
| |    | '_ \ / _' | __|
| |____| | | | (_| | |_ 
 \_____|_| |_|\__,_|\__|
`

	subtitle := "Start typing to begin your conversation"
	
	// Center the content vertically
	topPadding := (height - 10) / 2
	if topPadding < 0 {
		topPadding = 0
	}
	
	content := splashStyle.Render(logo) + "\n" + splashSubtitleStyle.Render(subtitle)
	
	// Add vertical padding
	padding := strings.Repeat("\n", topPadding)
	
	// Center horizontally
	centered := lipgloss.Place(width, height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
	
	return padding + centered
}