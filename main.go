package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type errMsg error

type model struct {
	viewport    viewport.Model
	messages    []string
	textarea    textarea.Model
	senderStyle lipgloss.Style
	botStyle    lipgloss.Style
	err         error
	thinking    bool
	spinner     spinner.Model
	help        help.Model
	keys        keyMap
}

type agentMessage struct {
	Text string
}

type keyMap struct {
	Quit key.Binding
}

func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Quit}
}

func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Quit},
	}
}

var keys = keyMap{
	Quit: key.NewBinding(
		key.WithKeys("ctrl+c", "esc"),
		key.WithHelp("esc", "quit"),
	),
}

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FAFAFA")).
			Background(lipgloss.Color("#7D56F4")).
			PaddingLeft(2).
			PaddingRight(2).
			MarginBottom(1)

	containerStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#874BFD")).
			Padding(1, 2)

	thinkingStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	userPrefix    = lipgloss.NewStyle().Foreground(lipgloss.Color("5")).Bold(true).Render("You: ")
	agentPrefix   = lipgloss.NewStyle().Foreground(lipgloss.Color("3")).Bold(true).Render("Agent: ")
)

func initialModel() model {
	ta := textarea.New()
	ta.Placeholder = "Type your message here..."
	ta.Focus()

	ta.Prompt = "❯ "
	ta.CharLimit = 1000

	ta.SetWidth(60)
	ta.SetHeight(3)

	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()
	ta.ShowLineNumbers = false

	vp := viewport.New(60, 15)
	vp.SetContent("Welcome to Unreal Agent CLI!\nStart chatting below.")

	sp := spinner.New()
	sp.Spinner = spinner.Pulse
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))

	return model{
		textarea: ta,
		messages: []string{},
		viewport: vp,
		spinner:  sp,
		help:     help.New(),
		keys:     keys,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.spinner.Tick)
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var (
		tiCmd tea.Cmd
		vpCmd tea.Cmd
		spCmd tea.Cmd
	)

	m.textarea, tiCmd = m.textarea.Update(msg)

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		h, v := containerStyle.GetFrameSize()
		m.viewport.Width = msg.Width - h
		m.viewport.Height = msg.Height - v - 8 // account for text area, title, help, etc.
		m.textarea.SetWidth(msg.Width - h)

	case tea.KeyMsg:
		switch {
		case key.Matches(msg, m.keys.Quit):
			return m, tea.Quit
		case msg.Type == tea.KeyUp || msg.Type == tea.KeyDown || msg.Type == tea.KeyPgUp || msg.Type == tea.KeyPgDown:
			m.viewport, vpCmd = m.viewport.Update(msg)
		case msg.Type == tea.KeyEnter:
			v := m.textarea.Value()
			if v == "" {
				return m, nil
			}

			v = strings.TrimSpace(v)

			m.messages = append(m.messages, userPrefix+v)
			m.viewport.SetContent(strings.Join(m.messages, "\n\n"))
			m.textarea.Reset()
			m.viewport.GotoBottom()

			m.thinking = true

			return m, m.sendMessage(v)
		}

	case agentMessage:
		m.thinking = false
		m.messages = append(m.messages, agentPrefix+msg.Text)
		m.viewport.SetContent(strings.Join(m.messages, "\n\n"))
		m.viewport.GotoBottom()

	case spinner.TickMsg:
		m.spinner, spCmd = m.spinner.Update(msg)

	case errMsg:
		m.err = msg
		return m, nil
	}

	return m, tea.Batch(tiCmd, vpCmd, spCmd)
}

func (m model) sendMessage(text string) tea.Cmd {
	return func() tea.Msg {
		reqBody := fmt.Sprintf(`{"messages": [{"role": "user", "content": %q}]}`, text)

		cmd := exec.Command("unreal-agent-runner", "-model", "gpt-4o")

		cmd.Env = os.Environ()
		cmd.Stdin = strings.NewReader(reqBody)

		out, err := cmd.Output()
		if err != nil {
			return agentMessage{Text: "Error communicating with agent: " + err.Error()}
		}

		var finalOutput string
		scanner := bufio.NewScanner(bytes.NewReader(out))

		// Increase max token size to handle long output from models
		const maxCapacity = 1024 * 1024 * 5 // 5MB limit
		buf := make([]byte, maxCapacity)
		scanner.Buffer(buf, maxCapacity)

		for scanner.Scan() {
			var item struct {
				Kind   string `json:"kind"`
				Output struct {
					Content struct {
						Role  string `json:"role"`
						Parts []struct {
							Kind string `json:"kind"`
							Text string `json:"text"`
						} `json:"parts"`
					} `json:"content"`
				} `json:"output"`
			}
			json.Unmarshal(scanner.Bytes(), &item)
			if item.Kind == "turn-complete" && item.Output.Content.Role == "model" {
				for _, part := range item.Output.Content.Parts {
					if part.Kind == "text" {
						finalOutput += part.Text
					}
				}
			}
		}

		if finalOutput == "" {
			if len(out) == 0 {
				finalOutput = "(No output received. Please check your API keys or agent logs.)"
			} else {
				finalOutput = "(Agent processed the request, but no text output was generated.)"
			}
		}

		return agentMessage{Text: finalOutput}
	}
}

func (m model) View() string {
	title := titleStyle.Render("Unreal Agent TUI")

	var status string
	if m.thinking {
		status = m.spinner.View() + thinkingStyle.Render(" Agent is thinking...")
	} else {
		status = lipgloss.NewStyle().Foreground(lipgloss.Color("241")).Render("Ready")
	}

	ui := fmt.Sprintf(
		"%s\n%s\n\n%s\n\n%s\n%s",
		title,
		m.viewport.View(),
		m.textarea.View(),
		status,
		m.help.View(m.keys),
	)

	return containerStyle.Render(ui) + "\n"
}

func main() {
	p := tea.NewProgram(initialModel(), tea.WithAltScreen())

	if _, err := p.Run(); err != nil {
		log.Fatal(err)
	}
}
