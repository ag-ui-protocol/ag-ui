from typing import Any, Literal, List, Dict, Optional

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import AgUiSpanProcessor
from pyagentspec.tracing.trace import Trace
from pyagentspec.tracing.spans.span import Span
from pyagentspec.tracing.spanprocessor import SpanProcessor
from ag_ui_agentspec.agentspecloader import load_agent_spec


class AgentSpecAgent:
    def __init__(
        self,
        agent_spec_config: str,
        runtime: Literal["langgraph", "wayflow"],
        tool_registry: Optional[Dict[str, Any]] = None,
        components_registry: Optional[Dict[str, Any]] = None,
        additional_processors: Optional[List[SpanProcessor]] = None,
    ):
        """
        Initialize an ``AgentSpecAgent`` instance.

        Parameters
        ----------
        agent_spec_config : str
            Agent specification configuration (serialized json) used to initialize the agent.
        runtime : {"langgraph", "wayflow"}
            Runtime backend to use for agent execution.
        tool_registry : dict[str, Any], optional
            Registry mapping server tool names to tool implementations (callables).
        components_registry : dict[str, Any], optional
            Used to load disaggregated configurations, e.g., API keys, URLs.
            This can be a dict of deserialized Agent Spec components.
            See pyagentspec.adapters.langgraph.agentspecloader.AgentSpecLoader documentation for more details.
        additional_processors : list[SpanProcessor], optional
            Additional span processors to attach to tracing/telemetry.
        """
        if runtime not in {"langgraph", "wayflow"}:
            raise NotImplementedError("other runtimes are not supported yet")
        self.runtime = runtime
        self.framework_agent = load_agent_spec(runtime, agent_spec_config, tool_registry, components_registry)
        self.processors = [AgUiSpanProcessor(runtime=runtime)] + (additional_processors or [])

    async def run(self, input_data: RunAgentInput) -> None:
        agent = self.framework_agent
        async with Trace(name="ag-ui run wrapper", span_processors=self.processors):
            async with Span(name="invoke_graph"):
                if self.runtime == "langgraph":
                    from ag_ui_agentspec.runtimes.langgraph_runner import run_langgraph_agent
                    await run_langgraph_agent(agent, input_data)
                elif self.runtime == "wayflow":
                    from ag_ui_agentspec.runtimes.wayflow_runner import run_wayflow
                    await run_wayflow(agent, input_data)
                else:
                    raise NotImplementedError(f"Unsupported runtime: {self.runtime}")
