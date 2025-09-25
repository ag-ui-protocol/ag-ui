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
import os

port = int(os.getenv("PORT", "9002"))
class FinanceAgent:
    """Finance Agent."""

    async def invoke(self, message: Message) -> str:
        response = openai.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "developer", "content": "You are simulating an agent in the finance department of a company, as part of a demo. You simulate being in charge of an ERP system, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. That's what the demo is about ;)"},
                {"role": "user", "content": message.parts[0].root.text}
            ]
        )
        return response.choices[0].message.content

skill = AgentSkill(
    id='finance_agent',
    name='The Finance Agent is in charge of the ERP system',
    description='The Finance Agent is in charge of the ERP system',
    tags=['finance', 'erp'],
    examples=[
        'Set up payroll for a new employee',
        'I want to purchase a new laptop for the office'
    ],
)

public_agent_card = AgentCard(
    name='Finance Agent',
    description='The Finance Agent is in charge of the ERP system',
    url=f'http://localhost:{port}/',
    version='1.0.0',
    defaultInputModes=['text'],
    defaultOutputModes=['text'],
    capabilities=AgentCapabilities(streaming=True),
    skills=[skill],  # Only the basic skill for the public card
    supportsAuthenticatedExtendedCard=True,
)


class FinanceAgentExecutor(AgentExecutor):
    """Finance Agent Implementation."""

    def __init__(self):
        self.agent = FinanceAgent()

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
        agent_executor=FinanceAgentExecutor(),
        task_store=InMemoryTaskStore(),
    )

    server = A2AStarletteApplication(
        agent_card=public_agent_card,
        http_handler=request_handler,
        extended_agent_card=public_agent_card,
    )

    uvicorn.run(server.build(), host='0.0.0.0', port=port)

if __name__ == '__main__':
    main()
