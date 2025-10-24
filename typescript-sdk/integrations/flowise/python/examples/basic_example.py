"""
Basic example of using Flowise with AG-UI
"""

from ag_ui_flowise import FlowiseAgent, FlowiseAgentConfig


def main():
    # Configure the Flowise agent
    config = FlowiseAgentConfig(
        api_url="http://localhost:3000/api/v1/prediction/{flowId}",
        flow_id="your-flow-id",
        api_key="your-api-key"  # Optional
    )
    
    # Create the agent
    agent = FlowiseAgent(config)
    
    # Prepare input data
    input_data = {
        'threadId': 'example-thread-id',
        'runId': 'example-run-id',
        'messages': [
            {
                'id': '1',
                'role': 'user',
                'content': 'Hello, how are you?'
            }
        ]
    }
    
    # Run the agent
    try:
        events = agent.run(input_data)
        for event in events:
            print(f"Event: {event}")
    except Exception as e:
        print(f"Error running agent: {e}")


if __name__ == "__main__":
    main()