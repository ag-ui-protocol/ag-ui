package io.workm8.agui4j.example;

import io.workm8.agui4j.langchain4j.LangchainAgent;
import io.workm8.agui4j.server.spring.AgUiParameters;
import io.workm8.agui4j.server.spring.AgUiService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;

@Controller
public class AgUiController {

    private final AgUiService agUiService;
    private final List<LangchainAgent> agents;

    @Autowired
    public AgUiController(
        final AgUiService agUiService,
        final List<LangchainAgent> agents
    ) {
        this.agUiService = agUiService;
        this.agents = agents;
    }

    @PostMapping(value = "/sse/{agentId}")
    public ResponseEntity<SseEmitter> streamData(@PathVariable("agentId") final String agentId, @RequestBody() final AgUiParameters agUiParameters) {
        var agent = agents.get(1);
        SseEmitter emitter = agUiService.runAgent(agent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

}
