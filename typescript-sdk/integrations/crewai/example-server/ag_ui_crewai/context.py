import contextvars
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from crewai.flow.flow import Flow

flow_context: contextvars.ContextVar['Flow'] = contextvars.ContextVar('flow')
