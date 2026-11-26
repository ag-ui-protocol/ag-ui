import os

import openai
from a2a.types import AgentSkill

from a2a_app import serve

port = int(os.getenv("PORT", "9003"))

INSTRUCTIONS = "You are simulating an agent in the IT department of a company, as part of a demo. You simulate being in charge of the IT infrastructure, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. If you set up a new account, let the user know the name @acme.com. That's what the demo is about ;)"


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
    id='it_agent',
    name='The IT Agent is in charge of the IT infrastructure',
    description='The IT Agent is in charge of the IT infrastructure',
    tags=['it', 'infrastructure'],
    examples=[
        'I want to purchase a new laptop for the office',
        'I want to set up a new email account for a new employee'
    ],
)


if __name__ == "__main__":
    serve(
        name='IT Agent',
        description='The IT Agent is in charge of the IT infrastructure. Set up new accounts, provision new devices, etc.',
        skill=skill,
        port=port,
        reply=reply,
    )
