from ag_ui.core.types import GENERATE_UI_TOOL_NAME, GenerateUserInterfaceToolArguments

def test_constants():
    assert GENERATE_UI_TOOL_NAME == "generateUserInterface"

def test_arguments_validation():
    # Valid arguments
    args = GenerateUserInterfaceToolArguments(
        description="A test form",
        data={"foo": "bar"},
        output={"type": "object"}
    )
    assert args.description == "A test form"
    assert args.data == {"foo": "bar"}
    assert args.output == {"type": "object"}

    # Minimal arguments
    args_minimal = GenerateUserInterfaceToolArguments(
        description="Minimal form"
    )
    assert args_minimal.description == "Minimal form"
    assert args_minimal.data is None
    assert args_minimal.output is None
