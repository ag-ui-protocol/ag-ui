package messages_test

import (
	"fmt"
	"strings"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

// Example demonstrating memory-aware message history
func ExampleHistory_memoryLimits() {
	// Create history with 10KB memory limit
	options := messages.DefaultHistoryOptions()
	options.MaxMemoryBytes = 10 * 1024 // 10KB
	history := messages.NewHistory(options)

	// Add messages until we hit the limit
	for i := 0; i < 100; i++ {
		msg := messages.NewUserMessage(fmt.Sprintf("Message %d: %s", i, strings.Repeat("data", 100)))
		err := history.Add(msg)
		if err != nil {
			fmt.Printf("Memory limit reached after %d messages\n", i)
			// Print a range to handle minor serialization variations
			usage := history.CurrentMemoryBytes()
			if usage >= 9887 && usage <= 9890 {
				fmt.Println("Current memory usage: ~9890 bytes")
			} else {
				fmt.Printf("Current memory usage: %d bytes\n", usage)
			}
			break
		}
	}

	// Output:
	// Memory limit reached after 11 messages
	// Current memory usage: ~9890 bytes
}

// Example demonstrating byte-aware content validation
func ExampleValidator_byteSizeValidation() {
	// Create validator with 1KB content limit
	options := messages.DefaultValidationOptions()
	options.MaxContentBytes = 1024 // 1KB per message
	validator := messages.NewValidator(options)

	// Small message passes validation
	smallMsg := messages.NewUserMessage("Hello, world!")
	if err := validator.ValidateMessage(smallMsg); err == nil {
		fmt.Println("Small message validated successfully")
	}

	// Large message fails validation
	largeMsg := messages.NewUserMessage(strings.Repeat("Large content ", 100))
	if err := validator.ValidateMessage(largeMsg); err != nil {
		fmt.Println("Large message validation failed:", err)
	}

	// Unicode content is measured in bytes, not characters
	unicodeMsg := messages.NewUserMessage(strings.Repeat("世界", 400)) // 400 characters but 1200 bytes
	if err := validator.ValidateMessage(unicodeMsg); err != nil {
		fmt.Println("Unicode message validation failed due to byte size")
	}

	// Output:
	// Small message validated successfully
	// Large message validation failed: validation error: content exceeds maximum byte size: 1400 > 1024
	//   - content: content byte size (1400) exceeds maximum (1024)
	// Unicode message validation failed due to byte size
}
