"""Very simply CLI to run the AG-UI example.

See https://ai.pydantic.dev/examples/ag-ui/ for more information.
"""

if __name__ == '__main__':
    import uvicorn

    uvicorn.run('pydantic_ai_examples.ag_ui:app', host='0.0.0.0', port=9000)
