# Java ADK Middleware Server

This directory should contain your Java implementation of the ADK middleware.

## 1. Project Structure

This project is set up as a standard Maven project. You should place your Java source code under `src/main/java`.

Your Java application should be a web server (e.g., using Spring Boot) that exposes an AG-UI compliant endpoint. You can use the `LocalAgent` class from the `com.agui.server` package as a base for your agent implementation.

Refer to the `sdks/community/java/examples/spring-ai-example` for a good example of how to structure a similar Java agent server.

## 2. Running the Server

Because this is a standard Maven project (and assuming you are using Spring Boot), you can typically run the server with:

```bash
# Navigate to this directory
cd integrations/adk-middleware/java

# Run the spring boot application
./mvnw spring-boot:run
```

This will start your Java server, ready to accept connections from the Dojo.

## 3. Connecting to the Dojo

To connect this server to the Dojo, you will need to:

1.  **Update Environment Variables:** Add a new variable to `apps/dojo/src/env.ts` to hold the URL of this server.
2.  **Update Dojo Agents:** Add a new entry to the `agentsIntegrations` array in `apps/dojo/src/agents.ts` to make the Dojo UI aware of your new agent.

I can guide you through these next steps once your Java server is ready.
