"""
Shared constants for Dojo example agents.

These are Claude Code's built-in filesystem / shell tools that are
generally not needed for AG-UI chat agents in the Dojo demo.
"""

DEFAULT_DISALLOWED_TOOLS: list[str] = [
    "Task",
    "TaskOutput",
    "Bash",
    "Glob",
    "Grep",
    "ExitPlanMode",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "TodoWrite",
    "WebSearch",
    "KillShell",
    "AskUserQuestion",
    "Skill",
    "EnterPlanMode",
]
