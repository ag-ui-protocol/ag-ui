"""Tool-based generative UI AgentSpec example."""

from __future__ import annotations

import os

import dotenv

from pyagentspec.agent import Agent
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.property import Property
from pyagentspec.serialization import AgentSpecSerializer
from pyagentspec.tools import ClientTool

dotenv.load_dotenv()


VALID_IMAGE_NAMES = [
    "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
    "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
    "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
    "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
    "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
    "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
    "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
    "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
    "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
    "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg",
]


japanese_property = Property(
    title="japanese",
    json_schema={
        "title": "japanese",
        "type": "array",
        "description": "Three haiku lines in Japanese, preserved in 5-7-5 syllable pattern.",
        "items": {"type": "string"},
        "minItems": 3,
        "maxItems": 3,
    },
)


english_property = Property(
    title="english",
    json_schema={
        "title": "english",
        "type": "array",
        "description": "Three English translations matching each Japanese line.",
        "items": {"type": "string"},
        "minItems": 3,
        "maxItems": 3,
    },
)


image_name_property = Property(
    title="image_name",
    json_schema={
        "title": "image_name",
        "type": "string",
        "description": "Filename of an illustration that complements the haiku.",
        "enum": VALID_IMAGE_NAMES,
    },
)


gradient_property = Property(
    title="gradient",
    json_schema={
        "title": "gradient",
        "type": "string",
        "description": "CSS gradient string used to style the haiku card background.",
    },
)


generate_haiku_tool = ClientTool(
    name="generate_haiku",
    description=(
        "Render a haiku to the UI by providing matching Japanese and English lines "
        "along with a thematic image and background gradient."
    ),
    inputs=[japanese_property, english_property, image_name_property, gradient_property],
)


agent_llm = OpenAiCompatibleConfig(
    name="tool_generative_ui_llm",
    model_id=os.getenv("OPENAI_MODEL", "gpt-4o"),
    url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)


tool_based_generative_ui_agent = Agent(
    name="tool_based_generative_ui_agent",
    description="Haiku assistant that uses a UI tool to present poetry and visuals.",
    system_prompt=(
        "You are a poetic assistant. When the user requests a haiku, you must call the "
        "`generate_haiku` tool exactly once, supplying three Japanese lines, three matching "
        "English lines, one image name from the allowed list, and a vivid CSS gradient. "
        "After the tool call, respond briefly to acknowledge what was created without "
        "repeating the haiku verbatim."
    ),
    llm_config=agent_llm,
    tools=[generate_haiku_tool],
)


tool_based_generative_ui_agent_json = AgentSpecSerializer().to_json(
    tool_based_generative_ui_agent
)
