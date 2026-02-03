import { AbstractAgent } from "../agent";
import { UiGenerator } from "../generative-ui";
import { GenerateUserInterfaceToolArguments, GENERATE_UI_TOOL_NAME, Message, RunAgentInput, BaseEvent } from "@ag-ui/core";
import { Observable, of } from "rxjs";

class TestAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
        return of();
    }
}

describe("Generative UI Integration", () => {
    let agent: TestAgent;
    let mockGenerator: UiGenerator;

    beforeEach(() => {
        agent = new TestAgent();
        mockGenerator = {
            generate: jest.fn().mockResolvedValue({ status: "success" }),
        };
        agent.registerUiGenerator(mockGenerator);
    });

    it("should intercept generateUserInterface tool calls and delegate to the generator", async () => {
        const toolCallArgs: GenerateUserInterfaceToolArguments = {
            description: "A test form",
            data: { foo: "bar" },
            output: { type: "object" },
        };

        const message: Message = {
            id: "msg-1",
            role: "assistant",
            content: "",
            toolCalls: [
                {
                    id: "call-1",
                    type: "function",
                    function: {
                        name: GENERATE_UI_TOOL_NAME,
                        arguments: JSON.stringify(toolCallArgs),
                    },
                },
            ],
        };

        // Simulate adding a message with the tool call
        agent.addMessage(message);

        // Wait a bit for the async processing (addMessage triggers async subscribers/processing)
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockGenerator.generate).toHaveBeenCalledWith(toolCallArgs);
    });

    it("should not intercept other tool calls", async () => {
        const message: Message = {
            id: "msg-2",
            role: "assistant",
            content: "",
            toolCalls: [
                {
                    id: "call-2",
                    type: "function",
                    function: {
                        name: "someOtherTool",
                        arguments: "{}",
                    },
                },
            ],
        };

        agent.addMessage(message);

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockGenerator.generate).not.toHaveBeenCalled();
    });
});
