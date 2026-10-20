"""The A2A server shared by the demo's department agents (a2a-sdk 1.x)."""

from collections.abc import Awaitable, Callable

import uvicorn
from starlette.applications import Starlette

from a2a.helpers import get_message_text, new_text_message
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill


class _ReplyExecutor(AgentExecutor):
    """Answers each message with one text reply from `reply`."""

    def __init__(self, reply: Callable[[str], Awaitable[str]]):
        self.reply = reply

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        text = await self.reply(get_message_text(context.message))
        await event_queue.enqueue_event(new_text_message(text))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise Exception("cancel not supported")


def serve(
    *,
    name: str,
    description: str,
    skill: AgentSkill,
    port: int,
    reply: Callable[[str], Awaitable[str]],
) -> None:
    url = f"http://localhost:{port}/"
    card = AgentCard(
        name=name,
        description=description,
        version="1.0.0",
        # One endpoint, both protocol versions: the A2A middleware's
        # @a2a-js/sdk 0.2 client speaks 0.3, which the JSON-RPC route accepts
        # with enable_v0_3_compat, and listing it makes the card carry the
        # legacy `url` field that client reads.
        supported_interfaces=[
            AgentInterface(url=url, protocol_binding="JSONRPC", protocol_version="1.0"),
            AgentInterface(url=url, protocol_binding="JSONRPC", protocol_version="0.3"),
        ],
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=AgentCapabilities(streaming=True),
        skills=[skill],
    )
    handler = DefaultRequestHandler(
        agent_executor=_ReplyExecutor(reply),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    app = Starlette(
        routes=[
            *create_agent_card_routes(card),
            # The path older clients (and the Dojo's readiness check) fetch.
            *create_agent_card_routes(card, card_url="/.well-known/agent.json"),
            *create_jsonrpc_routes(handler, rpc_url="/", enable_v0_3_compat=True),
        ]
    )
    uvicorn.run(app, host="0.0.0.0", port=port)
