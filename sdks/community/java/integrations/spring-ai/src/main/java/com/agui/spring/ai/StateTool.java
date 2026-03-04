package com.agui.spring.ai;

import com.agui.core.event.BaseEvent;
import com.agui.core.state.State;
import com.agui.server.EventFactory;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.ai.util.json.JsonParser;

import java.util.HashMap;
import java.util.List;

public class StateTool {

    private final SpringAIAgent agent;
    private final List<BaseEvent> deferredEvents;

    public StateTool(
        final SpringAIAgent agent,
        final List<BaseEvent> deferredEvents
    ) {
        this.agent = agent;
        this.deferredEvents = deferredEvents;
    }

    @Tool(description = "Update the current state", returnDirect = true)
    void updateState(@ToolParam(description = "The new state as a json string. Use the same keys as the existing state") final String stateJson) {
        var stateMap = JsonParser.fromJson(stateJson, HashMap.class);

        var state = new State(stateMap);

        agent.setState(state);

        this.deferredEvents.add(EventFactory.stateSnapshotEvent(state));
    }
}

