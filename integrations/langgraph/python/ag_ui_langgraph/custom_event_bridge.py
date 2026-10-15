"""Forward LangChain custom callbacks into LangGraph's custom stream mode."""

from copy import deepcopy
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langgraph.config import get_stream_writer


class AGUICustomEventBridge(BaseCallbackHandler):
    """Preserve ``dispatch_custom_event`` callbacks in AG-UI V3 streams.

    Add one instance to a transformer-enabled root graph with
    ``graph.with_config(callbacks=[AGUICustomEventBridge()])``. LangGraph
    merges these callbacks with the graph's existing callbacks and inherits
    them into its nodes and subgraphs. Do not also install the bridge on child
    graphs: the inherited instance already forwards their callbacks.

    Payloads are deep-copied at dispatch so later producer mutations cannot
    overwrite snapshots already queued for the stream.

    The handler runs inline to retain the executing node's stream writer and
    preserve callback order. It forwards the original name and payload without
    dispatching another callback, so existing observers still see one event.
    Errors propagate to the run instead of silently losing application events.
    """

    run_inline = True
    raise_error = True

    def on_custom_event(self, name: str, data: Any, **kwargs: Any) -> None:
        get_stream_writer()({"name": name, "payload": deepcopy(data)})
