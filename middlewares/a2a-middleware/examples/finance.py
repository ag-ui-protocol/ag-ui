import os

import openai
from a2a.types import AgentSkill

from a2a_app import serve

port = int(os.getenv("PORT", "9002"))

INSTRUCTIONS = "You are simulating an agent in the finance department of a company, as part of a demo. You simulate being in charge of an ERP system, and given request you will respond pretending to operate that system. But you will always simulate successfully carrying out the request. Never say the steps that need to be done to fulfill a request: REMEMBER: you are SIMULATING to be in charge of the system and you pretend to do any task yourself. That's what the demo is about ;)"


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
    id='finance_agent',
    name='The Finance Agent is in charge of the ERP system',
    description='The Finance Agent is in charge of the ERP system',
    tags=['finance', 'erp'],
    examples=[
        'Set up payroll for a new employee',
        'I want to purchase a new laptop for the office'
    ],
)


if __name__ == "__main__":
    serve(
        name='Finance Agent',
        description='The Finance Agent is in charge of the ERP system',
        skill=skill,
        port=port,
        reply=reply,
    )
