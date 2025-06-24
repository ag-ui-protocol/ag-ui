import uuid
import copy
import json
from typing import Any, cast
from crewai import Crew, Flow
from crewai.flow import start
from crewai.cli.crew_chat import (
  initialize_chat_llm as crew_chat_initialize_chat_llm,
  generate_crew_chat_inputs as crew_chat_generate_crew_chat_inputs,
  generate_crew_tool_schema as crew_chat_generate_crew_tool_schema,
  build_system_message as crew_chat_build_system_message,
  create_tool_function as crew_chat_create_tool_function
)
from litellm import completion
from .sdk import (
  copilotkit_stream,
  copilotkit_exit,
)

_CREW_INPUTS_CACHE = {}


CREW_EXIT_TOOL = {
    "type": "function",
    "function": {
        "name": "crew_exit",
        "description": "Call this when the user has indicated that they are done with the crew",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
}


class ChatWithCrewFlow(Flow):
    """Chat with crew"""

    def __init__(
            self, *,
            crew: Crew
        ):
        super().__init__()


        self.crew = copy.deepcopy(cast(Any, crew).crew())

        if self.crew.chat_llm is None:
            raise ValueError("Crew chat LLM is not set")

        self.crew_name = crew.name
        self.chat_llm = crew_chat_initialize_chat_llm(self.crew)

        if crew.name not in _CREW_INPUTS_CACHE:
            self.crew_chat_inputs = crew_chat_generate_crew_chat_inputs(
                self.crew,
                self.crew_name,
                self.chat_llm
            )
            _CREW_INPUTS_CACHE[ crew.name] = self.crew_chat_inputs
        else:
            self.crew_chat_inputs = _CREW_INPUTS_CACHE[ crew.name]

        self.crew_tool_schema = crew_chat_generate_crew_tool_schema(self.crew_chat_inputs)
        self.system_message = crew_chat_build_system_message(self.crew_chat_inputs)

        super().__init__()

    @start()
    async def chat(self):
        """Chat with the crew"""

        system_message = self.system_message
        if self.state.get("inputs"):
            system_message += "\n\nCurrent inputs: " + json.dumps(self.state["inputs"])

        messages = [
            {
                "role": "system",
                "content": system_message,
                "id": str(uuid.uuid4()) + "-system"
            },
            *self.state["messages"]
        ]

        tools = [action for action in self.state["copilotkit"]["actions"]
                 if action["function"]["name"] != self.crew_name]

        tools += [self.crew_tool_schema, CREW_EXIT_TOOL]

        response = await copilotkit_stream(
            completion(
                model=self.crew.chat_llm,
                messages=messages,
                tools=tools,
                parallel_tool_calls=False,
                stream=True
            )
        )

        message = cast(Any, response).choices[0]["message"]
        self.state["messages"].append(message)

        if message.get("tool_calls"):
            if message["tool_calls"][0]["function"]["name"] == self.crew_name:
                # run the crew
                crew_function = crew_chat_create_tool_function(self.crew, messages)
                args = json.loads(message["tool_calls"][0]["function"]["arguments"])
                result = crew_function(**args)

                if isinstance(result, str):
                    self.state["outputs"] = result
                elif hasattr(result, "json_dict"):
                    self.state["outputs"] = result.json_dict
                elif hasattr(result, "raw"):
                    self.state["outputs"] = result.raw
                else:
                    raise ValueError("Unexpected result type", type(result))

                self.state["messages"].append({
                    "role": "tool",
                    "content": result,
                    "tool_call_id": message["tool_calls"][0]["id"]
                })
            elif message["tool_calls"][0]["function"]["name"] == CREW_EXIT_TOOL["function"]["name"]:
                await copilotkit_exit()
                self.state["messages"].append({
                    "role": "tool",
                    "content": "Crew exited",
                    "tool_call_id": message["tool_calls"][0]["id"]
                })

                response = await copilotkit_stream(
                    completion( # pylint: disable=too-many-arguments
                        model=self.crew.chat_llm,
                        messages = [
                            {
                                "role": "system",
                                "content": "Indicate to the user that the crew has exited",
                                "id": str(uuid.uuid4()) + "-system"
                            },
                            *self.state["messages"]
                        ],
                        tools=tools,
                        parallel_tool_calls=False,
                        stream=True,
                        tool_choice="none"
                    )
                )
                message = cast(Any, response).choices[0]["message"]
                self.state["messages"].append(message)
