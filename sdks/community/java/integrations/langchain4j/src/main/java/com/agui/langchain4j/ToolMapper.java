package com.agui.langchain4j;

import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.model.chat.request.json.JsonObjectSchema;
import com.agui.core.tool.Tool;

/**
 * Utility class for converting agui tool definitions to LangChain4j tool specifications.
 * <p>
 * ToolMapper provides conversion functionality between agui's Tool format and LangChain4j's
 * ToolSpecification format, enabling seamless integration of function calling capabilities
 * between the two frameworks. The mapper handles tool metadata, parameter definitions,
 * and JSON schema conversion for proper tool registration with LangChain4j models.
 * <p>
 * The conversion process includes:
 * <ul>
 * <li>Tool name and description mapping</li>
 * <li>Parameter schema conversion to JSON Object Schema</li>
 * <li>Type validation and mapping for tool parameters</li>
 * <li>Property description preservation</li>
 * </ul>
 * <p>
 * Current limitations:
 * <ul>
 * <li>Only string parameter types are currently supported</li>
 * <li>Complex nested parameter structures are not yet implemented</li>
 * </ul>
 * <p>
 * This class is stateless and thread-safe, making it suitable for use in
 * concurrent environments and as a singleton or utility class.
 *
 * @author Pascal Wilbrink
 */
public class ToolMapper {

    /**
     * Converts an agui Tool to a LangChain4j ToolSpecification.
     * <p>
     * This method performs a comprehensive conversion of tool definitions, mapping
     * all essential tool metadata including name, description, and parameter specifications.
     * The parameter conversion uses JSON Object Schema format as required by LangChain4j
     * for proper function calling integration with language models.
     * <p>
     * The conversion process:
     * <ul>
     * <li>Directly maps tool name and description</li>
     * <li>Converts tool parameters to JsonObjectSchema via {@link #toJsonObjectSchema}</li>
     * <li>Builds a complete ToolSpecification ready for LangChain4j consumption</li>
     * </ul>
     * <p>
     * The resulting ToolSpecification can be used with LangChain4j's function calling
     * mechanisms, allowing language models to understand and invoke the tool with
     * properly typed parameters.
     *
     * @param tool the agui Tool to convert
     * @return a LangChain4j ToolSpecification with name, description, and parameter schema
     * @throws RuntimeException if the tool contains unsupported parameter types
     */
    public ToolSpecification toLangchainTool(final Tool tool) {
        return ToolSpecification.builder()
                .name(tool.name())
                .description(tool.description())
                .parameters(
                        this.toJsonObjectSchema(tool.parameters())
                ).build();
    }

    /**
     * Converts agui ToolParameters to a LangChain4j JsonObjectSchema.
     * <p>
     * This protected method handles the conversion of tool parameter definitions
     * from agui's format to LangChain4j's JSON Object Schema format. The schema
     * is used by language models to understand the expected structure and types
     * of parameters when making function calls.
     * <p>
     * The conversion process iterates through all parameter properties and maps
     * each one according to its declared type. Currently supported parameter types:
     * <ul>
     * <li>"string" - Mapped to string property with description</li>
     * </ul>
     * <p>
     * Parameter descriptions are preserved during conversion to provide language
     * models with sufficient context about each parameter's purpose and usage.
     * <p>
     * Future enhancements may include support for additional parameter types such as:
     * <ul>
     * <li>Integer and number types</li>
     * <li>Boolean types</li>
     * <li>Array and object types</li>
     * <li>Enum constraints</li>
     * </ul>
     *
     * @param params the agui ToolParameters containing parameter definitions
     * @return a JsonObjectSchema representing the tool's parameter structure
     * @throws RuntimeException if any parameter has an unsupported type
     */
    protected JsonObjectSchema toJsonObjectSchema(Tool.ToolParameters params) {
        var builder = JsonObjectSchema.builder();

        params.properties().forEach((key, value) -> {
            switch (value.type()) {
                case "string" -> builder.addStringProperty(key, value.description());
                default -> throw new RuntimeException("Tool parameter type %s for %s is not supported".formatted(value.type(), key));
            }
        });

        return builder.build();
    }
}