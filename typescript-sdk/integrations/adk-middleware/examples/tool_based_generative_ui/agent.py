# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from typing import Any, List

from google.adk.agents import Agent
from google.adk.tools import ToolContext
from google.genai import types

# List of available images (modify path if needed)
IMAGE_LIST = [
    "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
    "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
    "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
    "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
    "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
    "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
    "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
    "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
    "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
    "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg"
]



# Prepare the image list string for the prompt
image_list_str = "\n".join([f"- {img}" for img in IMAGE_LIST])

haiku_generator_agent = Agent(
    model='gemini-1.5-flash',
    name='haiku_generator_agent',
    instruction=f"""
        You are an expert haiku generator that creates beautiful Japanese haiku poems 
        and their English translations. You also have the ability to select relevant 
        images that complement the haiku's theme and mood.

        When generating a haiku:
        1. Create a traditional 5-7-5 syllable structure haiku in Japanese
        2. Provide an accurate and poetic English translation
        3. Select exactly 3 image filenames from the available list that best 
           represent or complement the haiku's theme, mood, or imagery

        Available images to choose from:
        {image_list_str}

        Always use the generate_haiku tool to create your haiku. The tool will handle 
        the formatting and validation of your response.

        Do not mention the selected image names in your conversational response to 
        the user - let the tool handle that information.

        Focus on creating haiku that capture the essence of Japanese poetry: 
        nature imagery, seasonal references, emotional depth, and moments of beauty 
        or contemplation.
    """,
    generate_content_config=types.GenerateContentConfig(
        temperature=0.7,  # Slightly higher temperature for creativity
        top_p=0.9,
        top_k=40
    ),
)