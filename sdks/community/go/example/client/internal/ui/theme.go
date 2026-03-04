package ui

import "github.com/charmbracelet/lipgloss"

// Theme colors inspired by Charmbracelet's design
var (
	// Primary colors
	primaryColor   = lipgloss.Color("#FF79C6")
	secondaryColor = lipgloss.Color("#8BE9FD")
	accentColor    = lipgloss.Color("#50FA7B")

	// Background colors
	bgColor       = lipgloss.Color("#282A36")
	bgLightColor  = lipgloss.Color("#44475A")
	bgDarkColor   = lipgloss.Color("#191A21")

	// Text colors
	textColor       = lipgloss.Color("#F8F8F2")
	mutedTextColor  = lipgloss.Color("#6272A4")
	brightTextColor = lipgloss.Color("#FFFFFF")

	// Status colors
	successColor = lipgloss.Color("#50FA7B")
	errorColor   = lipgloss.Color("#FF5555")
	warningColor = lipgloss.Color("#FFB86C")
	infoColor    = lipgloss.Color("#8BE9FD")
)

// Styles for the chat application
var (
	// Container styles
	AppStyle = lipgloss.NewStyle().
		Background(bgColor)

	// Header styles
	HeaderStyle = lipgloss.NewStyle().
		Foreground(primaryColor).
		Bold(true).
		Padding(1, 2)

	// Viewport styles
	ViewportStyle = lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(bgLightColor).
		Padding(1, 2)

	// Message styles
	UserLabelStyle = lipgloss.NewStyle().
		Foreground(primaryColor).
		Bold(true)

	AssistantLabelStyle = lipgloss.NewStyle().
		Foreground(secondaryColor).
		Bold(true)

	MessageContentStyle = lipgloss.NewStyle().
		Foreground(textColor).
		PaddingLeft(2)

	TimestampStyle = lipgloss.NewStyle().
		Foreground(mutedTextColor).
		Italic(true)

	// Input styles
	InputContainerStyle = lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(bgLightColor).
		Padding(0, 1)

	InputPromptStyle = lipgloss.NewStyle().
		Foreground(primaryColor)

	InputTextStyle = lipgloss.NewStyle().
		Foreground(textColor)

	InputPlaceholderStyle = lipgloss.NewStyle().
		Foreground(mutedTextColor)

	// Help styles
	HelpStyle = lipgloss.NewStyle().
		Foreground(mutedTextColor).
		Padding(1, 2)

	HelpKeyStyle = lipgloss.NewStyle().
		Foreground(secondaryColor)

	HelpDescStyle = lipgloss.NewStyle().
		Foreground(mutedTextColor)
)