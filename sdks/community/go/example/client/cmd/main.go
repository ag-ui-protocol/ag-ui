package main

import (
	"context"
	"log"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/agent"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/message"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

func runTea(p *tea.Program, userInputCh chan string) error {
	defer close(userInputCh)
	_, err := p.Run()
	return err
}

func main() {
	userInputCh := make(chan string)
	p := tea.NewProgram(ui.InitialModel(userInputCh), tea.WithAltScreen())

	sendUserInput := func(msg *message.Message) {
		p.Send(msg)
	}
	go func() {

		for msg := range userInputCh {
			err := agent.Chat(context.Background(), msg, agent.DefaultEndpoint(), sendUserInput)
			if err != nil {
				log.Fatal(err)
			}
		}
	}()

	teaErr := runTea(p, userInputCh)
	if teaErr != nil {
		log.Fatal(teaErr)
	}
}
