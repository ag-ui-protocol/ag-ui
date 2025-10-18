package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/message"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type UIMessage struct {
	Role      string
	Content   string
	Timestamp time.Time
}

func NewUIMessage(role, content string) UIMessage {
	return UIMessage{
		Role:      role,
		Content:   content,
		Timestamp: time.Now(),
	}
}

func (m UIMessage) String() string {
	var roleStyle lipgloss.Style
	var rolePrefix string

	if m.Role == "user" {
		roleStyle = UserLabelStyle
		rolePrefix = "You"
	} else {
		roleStyle = AssistantLabelStyle
		rolePrefix = "Assistant"
	}

	timestamp := m.Timestamp.Format("15:04")
	header := fmt.Sprintf("%s %s", roleStyle.Render(rolePrefix), TimestampStyle.Render(timestamp))
	content := MessageContentStyle.Render(m.Content)

	return fmt.Sprintf("%s\n%s", header, content)
}

type Model struct {
	messages       []UIMessage
	viewport       viewport.Model
	textarea       textarea.Model
	userInput      chan string
	ready          bool
	waitingForResp bool
	typingDots     int
}

func (m *Model) updateViewportContent() {
	if len(m.messages) == 0 {
		// Show splash screen when no messages
		m.viewport.SetContent(getSplashScreen(m.viewport.Width, m.viewport.Height))
		return
	}

	var content strings.Builder
	for i, msg := range m.messages {
		if i > 0 {
			content.WriteString("\n\n")
		}
		content.WriteString(msg.String())
	}

	// Add typing indicator if waiting for response
	if m.waitingForResp {
		content.WriteString("\n\n")
		content.WriteString(getTypingIndicator(m.typingDots))
	}

	m.viewport.SetContent(content.String())
	m.viewport.GotoBottom()
}

func getTextarea() textarea.Model {
	ta := textarea.New()
	ta.Placeholder = "Send a message..."
	ta.Focus()

	ta.Prompt = "│ "
	ta.CharLimit = 2000

	ta.SetWidth(80)
	ta.SetHeight(3)

	// Style the textarea
	ta.FocusedStyle.Base = lipgloss.NewStyle()
	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()
	ta.FocusedStyle.Placeholder = InputPlaceholderStyle
	ta.FocusedStyle.Text = InputTextStyle
	ta.FocusedStyle.Prompt = InputPromptStyle
	ta.BlurredStyle = ta.FocusedStyle

	ta.ShowLineNumbers = false
	return ta
}

func InitialModel(userInput chan string) *Model {
	vp := viewport.New(80, 20)
	vp.KeyMap = viewport.KeyMap{
		Up:       key.NewBinding(key.WithKeys("up", "k")),
		Down:     key.NewBinding(key.WithKeys("down", "j")),
		PageDown: key.NewBinding(key.WithKeys("pgdown")),
		PageUp:   key.NewBinding(key.WithKeys("pgup")),
	}

	return &Model{
		viewport:  vp,
		textarea:  getTextarea(),
		userInput: userInput,
		messages:  []UIMessage{},
	}
}

func (m *Model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, tea.EnterAltScreen, tickCmd())
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var (
		tiCmd tea.Cmd
		vpCmd tea.Cmd
	)

	m.textarea, tiCmd = m.textarea.Update(msg)
	m.viewport, vpCmd = m.viewport.Update(msg)

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		headerHeight := 2
		footHeight := lipgloss.Height(m.textareaView()) + 1
		verticalMarginHeight := headerHeight + footHeight

		if !m.ready {
			// Since this program is using the full size of the viewport we
			// need to wait until we've received the window dimensions before
			// we can initialize the viewport. The initial dimensions come in
			// quickly, though asynchronously, which is why we wait for them
			// here.
			m.viewport = viewport.New(msg.Width-4, msg.Height-verticalMarginHeight-2)
			m.viewport.KeyMap = viewport.KeyMap{
				Up:       key.NewBinding(key.WithKeys("up", "k")),
				Down:     key.NewBinding(key.WithKeys("down", "j")),
				PageDown: key.NewBinding(key.WithKeys("pgdown")),
				PageUp:   key.NewBinding(key.WithKeys("pgup")),
			}
			m.updateViewportContent()
			m.textarea.SetWidth(msg.Width - 4)
			m.ready = true
		} else {
			m.viewport.Width = msg.Width - 4
			m.viewport.Height = msg.Height - verticalMarginHeight - 2
			m.textarea.SetWidth(msg.Width - 4)
		}

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			return m, tea.Quit
		case tea.KeyEsc:
			if m.textarea.Focused() {
				m.textarea.Blur()
				m.viewport.YOffset = 0
			}
		case tea.KeyEnter:
			if m.textarea.Focused() && m.textarea.Value() != "" && !m.waitingForResp {
				// Send the message
				m.userInput <- m.textarea.Value()

				// Add to messages
				uiMsg := NewUIMessage("user", m.textarea.Value())
				m.messages = append(m.messages, uiMsg)
				m.updateViewportContent()
				m.textarea.Reset()
				m.waitingForResp = true
			}
		default:
			if !m.textarea.Focused() {
				switch msg.String() {
				case "i", "a":
					// Enter input mode
					m.textarea.Focus()
					return m, textarea.Blink
				}
			}
		}

	case *message.Message:
		m.waitingForResp = false
		for _, currMsg := range msg.Strings() {
			uiMsg := NewUIMessage("assistant", currMsg)
			m.messages = append(m.messages, uiMsg)
		}
		m.updateViewportContent()

	case tickMsg:
		m.typingDots++
		if m.waitingForResp {
			m.updateViewportContent()
		}
		return m, tickCmd()

	}

	return m, tea.Batch(tiCmd, vpCmd)
}

func (m *Model) textareaView() string {
	return InputContainerStyle.Render(m.textarea.View())
}

func (m *Model) View() string {
	if !m.ready {
		initMsg := lipgloss.NewStyle().
			Foreground(primaryColor).
			Bold(true).
			Render("\n  ✨ Initializing chat...")
		return initMsg
	}

	// Header with message count
	msgCount := ""
	if len(m.messages) > 0 {
		msgCount = TimestampStyle.Render(fmt.Sprintf(" (%d messages)", len(m.messages)))
	}
	header := HeaderStyle.Render("💬 Chat" + msgCount)

	// Viewport with scroll indicator
	viewportView := ViewportStyle.
		Width(m.viewport.Width + 2).
		Height(m.viewport.Height + 2).
		Render(m.viewport.View())

	// Add scroll percentage if there are messages
	if len(m.messages) > 0 && m.viewport.TotalLineCount() > m.viewport.Height {
		percent := float64(m.viewport.YOffset) / float64(m.viewport.TotalLineCount()-m.viewport.Height) * 100
		if percent < 0 {
			percent = 0
		}
		if percent > 100 {
			percent = 100
		}
		scrollInfo := TimestampStyle.Render(fmt.Sprintf(" %.0f%% ", percent))
		viewportView = lipgloss.JoinHorizontal(lipgloss.Top, viewportView, scrollInfo)
	}

	inputView := m.textareaView()

	// Build help text with styled keys
	helpItems := []string{
		HelpKeyStyle.Render("i/a") + " " + HelpDescStyle.Render("input mode"),
		HelpKeyStyle.Render("Esc") + " " + HelpDescStyle.Render("normal mode"),
		HelpKeyStyle.Render("Enter") + " " + HelpDescStyle.Render("send"),
		HelpKeyStyle.Render("Ctrl+C") + " " + HelpDescStyle.Render("quit"),
	}
	help := HelpStyle.Render(strings.Join(helpItems, " • "))

	// Add input mode indicator
	if m.textarea.Focused() {
		inputMode := lipgloss.NewStyle().
			Foreground(accentColor).
			Bold(true).
			Render(" [INPUT MODE]")
		header += inputMode
	}

	return fmt.Sprintf("%s\n\n%s\n\n%s\n%s", header, viewportView, inputView, help)
}
