"""
Shared constants for Dojo example agents.

These are Claude Code's built-in tools that are generally not needed
for AG-UI chat agents in the Dojo demo. Disabling them forces Claude
to use the AG-UI protocol tools (ag_ui_update_state, frontend tools, etc.)
instead of its own file/shell/task management tools.
"""

DEFAULT_DISALLOWED_TOOLS = frozenset([
    "Task",
    "TaskOutput",
    "TaskStop",
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
    "EnterWorktree",
    "ExitWorktree",
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    "CronCreate",
    "CronDelete",
    "CronList",
    "ToolSearch",
])
