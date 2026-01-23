package com.example.agent.web;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

import static org.springframework.web.reactive.function.server.RequestPredicates.POST;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

@Configuration
public class ApiRouter {

    @Bean
    public RouterFunction<ServerResponse> apiRoutes(ChatHandler chatHandler) {
        return route(POST("/chat"), chatHandler::handleRun);
    }
}
