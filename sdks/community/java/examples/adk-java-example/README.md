# Java ADK Example

This project is an example implementation of a Java ADK middleware server based on Spring Boot.

## 1. Project Structure

This project is a standard Maven project. The main application logic is in `src/main/java/com/example/agent/AgentApplication.java`.
It uses Spring Boot to create a web server that exposes an AG-UI compliant endpoint. The `ChatHandler` class implements the agent logic, and the `ApiRouter` class routes the requests to the handler.

## 2. Running the Server

Because this is a standard Spring Boot project, you can run the server with:

```bash
# Run the spring boot application
./mvnw spring-boot:run
```

This will start the Java server on `http://localhost:8080`.

## 3. Testing with Dojo

To test the project with Dojo:
1. First, run this project.
2. Then, set the environment variable `ADK_MIDDLEWARE_URL = 'http://localhost:8080'`. This environment variable is also used for the Python ADK integration.
3. Finally, run the Dojo app and select Google ADK from integrations in the UI.