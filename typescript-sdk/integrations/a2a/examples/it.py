import uvicorn

from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
)
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.utils import new_agent_text_message
from a2a.types import (
    Message
)
import openai

class ITAgent:
    """IT Agent."""

    async def invoke(self, message: Message) -> str:
        response = openai.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "developer", "content": "You are simulating an agent in the IT department of a company, as part of a demo. You simulate being in charge of the IT infrastructure, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. If you set up a new account, let the user know the name @acme.com. That's what the demo is about ;)"},
                {"role": "user", "content": message.parts[0].root.text}
            ]
        )
        return response.choices[0].message.content

skill = AgentSkill(
    id='it_agent',
    name='The IT Agent is in charge of the IT infrastructure',
    description='The IT Agent is in charge of the IT infrastructure',
    tags=['it', 'infrastructure'],
    examples=[
        'I want to purchase a new laptop for the office',
        'I want to set up a new email account for a new employee'
    ],
)

public_agent_card = AgentCard(
    name='IT Agent',
    description='The IT Agent is in charge of the IT infrastructure. Set up new accounts, provision new devices, etc.',
    url='http://localhost:9998/',
    version='1.0.0',
    defaultInputModes=['text'],
    defaultOutputModes=['text'],
    capabilities=AgentCapabilities(streaming=True),
    skills=[skill],  # Only the basic skill for the public card
    supportsAuthenticatedExtendedCard=True,
)


class ITAgentExecutor(AgentExecutor):
    """IT Agent Implementation."""

    def __init__(self):
        self.agent = ITAgent()

    async def execute(
        self,
        context: RequestContext,
        event_queue: EventQueue,
    ) -> None:
        result = await self.agent.invoke(context.message)
        await event_queue.enqueue_event(new_agent_text_message(result))

    async def cancel(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        raise Exception('cancel not supported')


def main():
    request_handler = DefaultRequestHandler(
        agent_executor=ITAgentExecutor(),
        task_store=InMemoryTaskStore(),
    )

    server = A2AStarletteApplication(
        agent_card=public_agent_card,
        http_handler=request_handler,
        extended_agent_card=public_agent_card,
    )

    uvicorn.run(server.build(), host='0.0.0.0', port=9998)

if __name__ == '__main__':
    main()
