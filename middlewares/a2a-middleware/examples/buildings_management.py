import os

import openai
from a2a.types import AgentSkill

from a2a_app import serve

port = int(os.getenv("PORT", "9001"))

INSTRUCTIONS = "You are simulating an agent in the Buildings Management department of a company, as part of a demo. You simulate being in charge of the buildings management, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. That's what the demo is about ;) When asked to find available desks for an engineer, there are three desks available: A, B and C. Table A Seat 2 is taken by Alice Williams. Seat 1 is available. Table B Seat 1 is taken by Bob Smith. Seat 2 is also taken by Greg Brown. Table C Seat 1 is taken by Susanne Torelli. Seat 2 is available. If asked to find a table for an employee without a concrete seat, reply by giving the current tables, all people sitting at the tables and ask to pick a seat."


async def reply(text: str) -> str:
    response = openai.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "developer", "content": INSTRUCTIONS},
            {"role": "user", "content": text},
        ],
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


if __name__ == "__main__":
    serve(
        name='Buildings Management Agent',
        description='The Buildings Management Agent is in charge of the buildings management',
        skill=skill,
        port=port,
        reply=reply,
    )
