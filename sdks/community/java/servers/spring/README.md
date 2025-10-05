# AG-UI-4J Spring

![Java](https://img.shields.io/badge/Java-17-orange?logo=openjdk&logoColor=white)
![Maven](https://img.shields.io/badge/Maven-0.0.1-C71A36?logo=apachemaven&logoColor=white)
---

This package contains an [AgUiService](./src/main/java/com/agui/server/spring/AgUiService.java) that runs an agent and returns a SSeEmitter.

### Usage

```java

import org.springframework.web.bind.annotation.GetMapping;

@PostMapping(value = "/sse/{agentId}")
public ResponseEntity<SseEmitter> streamData(@PathVariable("agentId") final String agentId, @RequestBody() final AgUiParameters agUiParameters) {
    SseEmitter emitter = agUiService.runAgent(agent, agUiParameters);

    return ResponseEntity
        .ok()
        .cacheControl(CacheControl.noCache())
        .body(emitter);
}
```

### Dependency

```xml
<dependency>
    <groupId>com.ag-ui</groupId>
    <artifactId>spring</artifactId>
    <version>0.0.1</version>
</dependency>
```
