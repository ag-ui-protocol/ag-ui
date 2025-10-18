# AG-UI-4J Spring-AI

![Java](https://img.shields.io/badge/Java-17-orange?logo=openjdk&logoColor=white)
![Maven](https://img.shields.io/badge/Maven-1.0.1-C71A36?logo=apachemaven&logoColor=white)
---

This package contains a [Spring AI Agent](./src/main/java/com/agui/spring/ai/SpringAiAgent.java) with Builder.

### Usage
```java
// Set up the Chat Model
var openai = OpenAiChatModel.builder()
    .defaultOptions(OpenAiChatOptions.builder()
        .model("gpt-4o")
        .build()
    )
    .openAiApi(OpenAiApi.builder()
        .apiKey(apiKey)
        .build()
    )
    .build();

// Set up the Chat Memory
ChatMemory chatMemory = MessageWindowChatMemory.builder()
    .chatMemoryRepository(new InMemoryChatMemoryRepository())
    .maxMessages(10)
    .build();

// Set up the Agent
var agent = SpringAIAgent.builder()
    .agentId("1")
    .chatMemory(chatMemory)
    .chatModel(openai)
    .systemMessage("You are a helpful AI assistant.")
    .state(new State())
    .build();
```
### Dependency

```xml
<dependency>
    <groupId>com.ag-ui</groupId>
    <artifactId>spring-ai</artifactId>
    <version>1.0.1</version>
</dependency>
```

#### Note
This package follows the versioning of Spring AI.