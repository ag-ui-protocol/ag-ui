import assert from "node:assert/strict";
import test from "node:test";
import { LLMock, type ChatCompletionRequest } from "@copilotkit/aimock";
import { validateOperation } from "@copilotkit/shared";
import { standardUI } from "@copilotkit/react-core/v2/generative-ui";
import {
  GENERATIVE_UI_PROMPT,
  registerGenerativeUIFixtures,
} from "./generative-ui-fixtures";

for (const transport of ["markdown", "tool"] as const) {
  test(`Generative UI ${transport} fixture uses the published native protocol`, async () => {
    const server = new LLMock();
    registerGenerativeUIFixtures(server);
    const request: ChatCompletionRequest = {
      model: "scripted",
      messages: [
        {
          role: "system",
          content:
            transport === "markdown"
              ? "Generative UI markdown guide"
              : "Generative UI guide",
        },
        { role: "user", content: GENERATIVE_UI_PROMPT },
      ],
      ...(transport === "tool"
        ? {
            tools: [
              { type: "function" as const, function: { name: "render_ui" } },
            ],
          }
        : {}),
    };
    const fixture = server
      .getFixtures()
      .find((item) => item.match.predicate?.(request));
    assert.ok(fixture, "the shared success fixture must match this transport");
    const response =
      typeof fixture.response === "function"
        ? await fixture.response(request)
        : fixture.response;
    assert.ok(
      response && typeof response === "object" && !Array.isArray(response),
    );
    let operations: unknown[];
    if (transport === "markdown") {
      assert.ok("content" in response && typeof response.content === "string");
      const fence = response.content.match(/```a2ui\n([\s\S]*?)\n```/);
      assert.ok(
        fence,
        "the markdown response must contain the A2UI operations",
      );
      operations = fence[1].split("\n").map((line) => JSON.parse(line));
    } else {
      assert.ok("toolCalls" in response && Array.isArray(response.toolCalls));
      assert.equal(response.toolCalls[0].name, "render_ui");
      const args = JSON.parse(response.toolCalls[0].arguments);
      assert.equal(args.target, "chat");
      operations = args.operations;
    }
    assert.ok(operations.length > 0);
    const knownSurfaces = new Set<string>();
    for (const operation of operations) {
      assert.deepEqual(
        validateOperation(operation, {
          manifest: {
            catalogId: standardUI.id,
            components: standardUI.manifestComponents,
          },
          knownSurfaces,
        }),
        { ok: true },
      );
      if (
        operation &&
        typeof operation === "object" &&
        "createSurface" in operation
      ) {
        const create = operation.createSurface as { surfaceId: string };
        knownSurfaces.add(create.surfaceId);
      }
    }
  });
}
