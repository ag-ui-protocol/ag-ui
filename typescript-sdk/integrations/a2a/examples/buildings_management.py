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

class BuildingsManagementAgent:
    """Buildings Management Agent."""

    async def invoke(self, message: Message) -> str:
        response = openai.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "developer", "content": "You are simulating an agent in the Buildings Management department of a company, as part of a demo. You simulate being in charge of the buildings management, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. That's what the demo is about ;) When asked to find available desks for an engineer, there are three desks available: A, B and C. Table A Seat 2 is taken by Alice Williams. Seat 1 is available. Table B Seat 1 is taken by Bob Smith. Seat 2 is also taken by Greg Brown. Table C Seat 1 is taken by Susanne Torelli. Seat 2 is available. If asked to find a table for an employee without a concrete seat, reply by giving the current tables, all people sitting at the tables and ask to pick a seat."},
                {"role": "user", "content": message.parts[0].root.text}
            ]
        )
        return response.choices[0].message.content

skill = AgentSkill(
    id='buildings_management_agent',
    name='The Buildings Management Agent is in charge of the buildings management',
    description='The Buildings Management Agent is in charge of the buildings management',
    tags=['buildings', 'management'],
    examples=[
        "I want to find available desks in the office",
        "I want to book a meeting room for tomorrow"
    ],
)

public_agent_card = AgentCard(
    name='Buildings Management Agent',
    description='The Buildings Management Agent is in charge of the buildings management',
    url='http://localhost:9997/',
    version='1.0.0',
    defaultInputModes=['text'],
    defaultOutputModes=['text'],
    capabilities=AgentCapabilities(streaming=True),
    skills=[skill],  # Only the basic skill for the public card
    supportsAuthenticatedExtendedCard=True,
)


class BuildingsManagementAgentExecutor(AgentExecutor):
    """Buildings Management Agent Implementation."""

    def __init__(self):
        self.agent = BuildingsManagementAgent()

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
        agent_executor=BuildingsManagementAgentExecutor(),
        task_store=InMemoryTaskStore(),
    )

    server = A2AStarletteApplication(
        agent_card=public_agent_card,
        http_handler=request_handler,
        extended_agent_card=public_agent_card,
    )

    uvicorn.run(server.build(), host='0.0.0.0', port=9997)

if __name__ == '__main__':
    main()
