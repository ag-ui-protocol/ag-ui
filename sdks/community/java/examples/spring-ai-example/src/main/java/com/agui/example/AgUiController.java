package com.agui.example;

import com.agui.server.spring.AgUiParameters;
import com.agui.server.spring.AgUiService;
import com.agui.spring.ai.SpringAIAgent;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
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

    private final SpringAIAgent agenticChatAgent;
    private final SpringAIAgent sharedStateAgent;

    @Autowired
    public AgUiController(
        final AgUiService agUiService,
        @Qualifier("AgenticChat") final SpringAIAgent agenticChatAgent,
        @Qualifier("SharedState") final SpringAIAgent sharedStateAgent
    ) {
        this.agUiService = agUiService;
        this.agenticChatAgent = agenticChatAgent;
        this.sharedStateAgent = sharedStateAgent;
    }

    @PostMapping("agentic_chat/agui")
    public ResponseEntity<SseEmitter> agenticChat(@RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agenticChatAgent, agUiParameters);

        return ResponseEntity
                .ok()
                .cacheControl(CacheControl.noCache())
                .body(emitter);
    }

    @PostMapping("shared_state/agui")
    public ResponseEntity<SseEmitter> sharedState(@RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.sharedStateAgent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

    @PostMapping("tool_based_generative_ui/agui")
    public ResponseEntity<SseEmitter> ToolBasedGenerativeUi(@RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agenticChatAgent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

    @PostMapping("human_in_the_loop/agui")
    public ResponseEntity<SseEmitter> humanInTheLoop(@RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agenticChatAgent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

    @PostMapping("agentic_generative_ui/agui")
    public ResponseEntity<SseEmitter> agenticGenerativeUi(@RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agenticChatAgent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

    @PostMapping(value = "/sse/{agentId}")
    public ResponseEntity<SseEmitter> streamData(@PathVariable("agentId") final String agentId, @RequestBody() final AgUiParameters agUiParameters) {
        SseEmitter emitter = this.agUiService.runAgent(this.agenticChatAgent, agUiParameters);

        return ResponseEntity
            .ok()
            .cacheControl(CacheControl.noCache())
            .body(emitter);
    }

}
