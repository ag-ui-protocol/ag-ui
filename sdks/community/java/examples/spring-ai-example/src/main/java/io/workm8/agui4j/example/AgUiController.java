package io.workm8.agui4j.example;

import io.workm8.agui4j.server.spring.AgUiParameters;
import io.workm8.agui4j.server.spring.AgUiService;
import io.workm8.agui4j.spring.ai.SpringAIAgent;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Controller
public class AgUiController {

    private final AgUiService agUiService;

    private final SpringAIAgent agent;

    @Autowired
    public AgUiController(
        final AgUiService agUiService,
        final SpringAIAgent agent
    ) {
        this.agUiService = agUiService;
        this.agent = agent;
    }

    @PostMapping(value = "/sse/{agentId}")
    public ResponseEntity<SseEmitter> streamData(@PathVariable("agentId") final String agentId, @RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

}
