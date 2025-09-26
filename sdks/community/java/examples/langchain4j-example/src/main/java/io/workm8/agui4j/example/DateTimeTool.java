package io.workm8.agui4j.example;

import dev.langchain4j.agent.tool.Tool;
import org.springframework.context.i18n.LocaleContextHolder;

import java.time.LocalDateTime;

public class DateTimeTool {

    @Tool("gets the current date")
    public String getCurrentDate() {
        return LocalDateTime.now().atZone(LocaleContextHolder.getTimeZone().toZoneId()).toString();
    }
}
