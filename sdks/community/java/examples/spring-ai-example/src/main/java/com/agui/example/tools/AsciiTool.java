package com.agui.example.tools;

import com.github.lalyos.jfiglet.FigletFont;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

@Component
public class AsciiTool {

    @Tool(description = "Create ascii art from a given string")
    public String createAsciiArt(@ToolParam(description = "The input that needs to be converted to ascii art") final String input) {
        try {
            return FigletFont.convertOneLine(input);
        } catch (Exception e) {
            e.printStackTrace();
        }
        return "";
    }

}
