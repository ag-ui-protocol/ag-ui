"""
Advanced example of using Flowise with AG-UI
"""

import asyncio
from ag_ui_flowise import FlowiseAgent, FlowiseAgentConfig


async def main():
    # Configure the Flowise agent
    config = FlowiseAgentConfig(
        api_url="http://localhost:3000/api/v1/prediction/{flowId}",
        flow_id="your-flow-id",
        api_key="your-api-key",  # Optional
        headers={
            "Custom-Header": "custom-value"
        }
    )
    
    # Create the agent
    agent = FlowiseAgent(config)
    
    # Prepare input data with conversation history
    input_data = {
        'threadId': 'example-thread-id',
        'runId': 'example-run-id',
        'messages': [
            {
                'id': '1',
                'role': 'user',
                'content': 'Hello, how are you?'
            },
            {
                'id': '2',
                'role': 'assistant',
                'content': 'I am doing well, thank you for asking!'
            },
            {
                'id': '3',
                'role': 'user',
                'content': 'What can you help me with?'
            }
        ]
    }
    
    # Run the agent
    try:
        events = agent.run(input_data)
        for event in events:
            print(f"Event type: {event.type}")
            # Process events as needed for your application
    except Exception as e:
        print(f"Error running agent: {e}")


if __name__ == "__main__":
    asyncio.run(main())