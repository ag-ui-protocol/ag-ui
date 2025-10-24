# LangGraph examples

## How to run

First, make sure to create a new .env file from the .env.example and include the required keys.

To run the Python examples for langgraph platform, run:
```
cd integrations/langgraph/python/examples
pnpx @langchain/langgraph-cli@latest dev
```

To run the python examples using FastAPI, run:
```
cd integrations/langgraph/python/examples
poetry install
poetry run dev
```

Note that when running them both concurrently, poetry and the langgraph-cli will step on eachothers toes and install/uninstall eachothers dependencies.
You can fix this by running the poetry commands with virtualenvs.in-project set to false. You can set this permanently for the project using:
`poetry config virtualenvs.create false --local`, globally using `poetry config virtualenvs.create false`, or temporarily using an environment variable:

```
export POETRY_VIRTUALENVS_IN_PROJECT=false
poetry install
poetry run dev
```
or
```
POETRY_VIRTUALENVS_IN_PROJECT=false poetry install
POETRY_VIRTUALENVS_IN_PROJECT=false poetry run dev
```
