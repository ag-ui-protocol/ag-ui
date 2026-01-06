from typing import Literal

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import AgUiSpanProcessor
from pyagentspec.tracing.trace import Trace
from pyagentspec.tracing.spans.span import Span
from ag_ui_agentspec.agentspecloader import load_agent_spec


class AgentSpecAgent:
    def __init__(
        self,
        agent_spec_config: str,
        runtime: Literal["langgraph", "wayflow"],
        tool_registry=None,
        additional_processors=None
    ):
        if runtime not in {"langgraph", "wayflow"}:
            raise NotImplementedError("other runtimes are not supported yet")
        self.runtime = runtime
        self.framework_agent = load_agent_spec(runtime, agent_spec_config, tool_registry)
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
