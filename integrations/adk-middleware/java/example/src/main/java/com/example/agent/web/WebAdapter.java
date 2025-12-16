//package com.example.agent.web;
//
//import com.fasterxml.jackson.databind.ObjectMapper;
//import com.google.adk.agents.RunConfig;
//import com.google.adk.events.Event;
//import com.google.adk.runner.Runner;
//import com.google.adk.sessions.BaseSessionService;
//import com.google.genai.types.Content;
//import com.google.genai.types.Part;
//import org.springframework.context.annotation.Bean;
//import org.springframework.context.annotation.Configuration;
//import org.springframework.http.MediaType;
//import org.springframework.web.reactive.function.server.RouterFunction;
//import org.springframework.web.reactive.function.server.ServerRequest;
//import org.springframework.web.reactive.function.server.ServerResponse;
//import reactor.core.publisher.Flux;
//import reactor.core.publisher.Mono;
//import reactor.core.scheduler.Schedulers;
//
//import static org.springframework.web.reactive.function.server.RequestPredicates.POST;
//import static org.springframework.web.reactive.function.server.RouterFunctions.route;
//
//
//@Configuration
//public class WebAdapter {
//
//    private final Runner runner;
//    private final RunConfig runConfig;
//    private final BaseSessionService sessionService;
//    private final ObjectMapper objectMapper; // Add ObjectMapper
//
//    public WebAdapter(Runner runner, RunConfig runConfig, BaseSessionService sessionService1, ObjectMapper objectMapper) {
//        this.runner = runner;
//        this.runConfig = runConfig;
//        this.sessionService = sessionService1;
//        this.objectMapper = objectMapper; // Initialize ObjectMapper
//    }
//
//    @Bean
//    public RouterFunction<ServerResponse> routes() {
//        return route(POST("/run9"), this::handleRun);
//    }
//
//    private Mono<ServerResponse> handleRun(ServerRequest request) {
//
//        String appName = "appName"; //request.pathVariable("appName");
//        String userId = "default-user"; //request.queryParam("userId").orElse("default-user");
//        //        String sessionId = "default-session"; //request.queryParam("sessionId").orElse("default-session");
//        String message = "create java class for car"; //request.queryParam("message").orElse("Hello");
//
//        return RxJava3Adapter.singleToMono(sessionService.createSession(appName, userId))
//                .flatMap(session -> {
//                    Content newMessage = Content.builder()
//                            .parts(Part.fromText(message))
//                            .build();
//
//                    Flux<Event> eventFlux = Flux.from(runner.runAsync(userId, session.id(), newMessage, runConfig));
//
//                    return ServerResponse.ok()
//                            .contentType(MediaType.TEXT_EVENT_STREAM)
//                            .body(eventFlux, String.class);
//                })
//                .subscribeOn(Schedulers.boundedElastic());
//    }
//
//}
