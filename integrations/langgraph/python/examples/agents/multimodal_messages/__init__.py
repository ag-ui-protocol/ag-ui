"""
Multimodal Messages Example

This example demonstrates how to use AG-UI's multimodal message support
to send and receive messages containing both text and images.

Key features:
- User messages can contain text and binary content (images, audio, files)
- Automatic conversion between AG-UI and LangChain multimodal formats
- Support for vision models like GPT-4o and Claude 3

Example usage:

```python
from ag_ui.core import UserMessage, TextInputContent, BinaryInputContent

# Create a multimodal user message
message = UserMessage(
    id="user-123",
    content=[
        TextInputContent(text="What's in this image?"),
        BinaryInputContent(
            mime_type="image/jpeg",
            url="https://example.com/photo.jpg"
        ),
    ],
)

# Or with base64 encoded data
message_with_data = UserMessage(
    id="user-124",
    content=[
        TextInputContent(text="Describe this picture"),
        BinaryInputContent(
            mime_type="image/png",
            data="iVBORw0KGgoAAAANSUhEUgAAAAUA...",  # base64 encoded
            filename="screenshot.png"
        ),
    ],
)
```

The LangGraph integration automatically handles:
1. Converting AG-UI multimodal format to LangChain's format
2. Passing multimodal messages to vision models
3. Converting responses back to AG-UI format
"""

from .agent import graph

__all__ = ["graph"]
