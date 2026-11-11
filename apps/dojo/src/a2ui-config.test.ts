import assert from "node:assert/strict";
import test from "node:test";

import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  A2UIMiddleware,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
} from "../../../middlewares/a2ui-middleware/src/index";
import { Observable, firstValueFrom, toArray } from "rxjs";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
} from "@copilotkit/aimock";
import {
  crewAIA2UIAnswersToolResultTurn,
  registerA2UICrewAIFixtures,
} from "../e2e/a2ui-crewai-fixtures";

import { dynamicSchemaCatalog } from "./a2ui-catalog";
import { DOJO_A2UI_MIDDLEWARE_CONFIG } from "./a2ui-config";

class CaptureAgent extends AbstractAgent {
  readonly runCalls: RunAgentInput[] = [];

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

test("Dojo A2UI middleware forwards the rendered dynamic catalog", async () => {
  const downstream = new CaptureAgent();
  const middleware = new A2UIMiddleware(DOJO_A2UI_MIDDLEWARE_CONFIG);

  await firstValueFrom(
    middleware
      .run(
        {
          threadId: "test-thread",
          runId: "test-run",
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
          messages: [],
        },
        downstream,
      )
      .pipe(toArray()),
  );

  assert.equal(downstream.runCalls.length, 1);
  const forwarded = downstream.runCalls[0];
  const schemaContext = forwarded.context.find(
    ({ description }) => description === A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  );
  assert.ok(
    schemaContext && typeof schemaContext.value === "string",
    "dynamic catalog schema must reach downstream agent context",
  );

  const schema = JSON.parse(schemaContext.value) as {
    catalogId: string;
    components: Record<
      string,
      { allOf?: Array<{ properties?: Record<string, unknown> }> }
    >;
  };
  assert.equal(schema.catalogId, dynamicSchemaCatalog.id);
  assert.deepEqual(Object.keys(schema.components), [
    ...dynamicSchemaCatalog.components.keys(),
  ]);

  const hotelProperties = schema.components.HotelCard.allOf?.find(
    ({ properties }) => properties,
  )?.properties;
  assert.ok(hotelProperties);
  assert.ok("pricePerNight" in hotelProperties);
  const rating = hotelProperties.rating as {
    anyOf?: Array<{ type?: string }>;
  };
  assert.ok(rating.anyOf?.some(({ type }) => type === "number"));
});

const crewAIPrompt = {
  id: "hotel-request",
  role: "user" as const,
  content: "Compare three boutique hotels with nightly prices and ratings.",
};

async function emittedActionMessages(
  messages: RunAgentInput["messages"],
  hotelName: string,
  runId = "first-click",
): Promise<RunAgentInput["messages"]> {
  const downstream = new CaptureAgent();
  await firstValueFrom(
    new A2UIMiddleware()
      .run(
        {
          threadId: "crewai-action-thread",
          runId,
          messages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {
            a2uiAction: {
              userAction: {
                name: "book_hotel",
                surfaceId: "hotel-comparison",
                sourceComponentId: "card",
                context: { hotelName, pricePerNight: "$180" },
              },
            },
          },
        },
        downstream,
      )
      .pipe(toArray()),
  );
  const forwarded = downstream.runCalls[0].messages;
  assert.equal(forwarded.at(-1)?.role, "user");
  return forwarded;
}

function crewAIRequest(
  messages: RunAgentInput["messages"],
): ChatCompletionRequest {
  return {
    model: "gpt-5.4",
    _endpointType: "chat",
    messages: messages.map((message) => {
      assert.ok(message.role === "user" || message.role === "assistant");
      assert.ok(typeof message.content === "string");
      return { role: message.role, content: message.content };
    }),
    tools: [{ type: "function", function: { name: "generate_a2ui" } }],
  };
}

function crewAIFixture(request: ChatCompletionRequest) {
  const mockServer = new LLMock();
  registerA2UICrewAIFixtures(mockServer);
  return matchFixture([...mockServer.getFixtures()], request);
}

async function crewAIActionReply(request: ChatCompletionRequest) {
  assert.equal(crewAIA2UIAnswersToolResultTurn(request), true);
  const fixture = crewAIFixture(request);
  assert.ok(fixture, "The CrewAI surface-action fixture must match");
  assert.equal(typeof fixture.response, "function");
  assert.ok(typeof fixture.response === "function");
  return fixture.response(request);
}

test("CrewAI fixture answers the actual middleware's user action with its hotel context", async () => {
  const messages = await emittedActionMessages([crewAIPrompt], "Holiday Inn");
  const reply = await crewAIActionReply(crewAIRequest(messages));
  assert.deepEqual(reply, {
    content:
      "You are booked at Holiday Inn for $180 a night. Your confirmation is on its way.",
  });
});

test("CrewAI fixture answers the latest repeated click rather than an earlier action", async () => {
  const first = await emittedActionMessages([crewAIPrompt], "Holiday Inn");
  const second = await emittedActionMessages(
    [
      ...first,
      {
        id: "first-reply",
        role: "assistant",
        content: "First booking confirmed.",
      },
    ],
    "Boutique Loft",
    "second-click",
  );
  assert.deepEqual(await crewAIActionReply(crewAIRequest(second)), {
    content:
      "You are booked at Boutique Loft for $180 a night. Your confirmation is on its way.",
  });
});

test("CrewAI action fixtures retain the latest real prompt's integration scope", async () => {
  const messages = await emittedActionMessages(
    [
      crewAIPrompt,
      {
        id: "other-integration",
        role: "user",
        content: "Create a comparison of 3 hotels.",
      },
    ],
    "Holiday Inn",
  );
  const request = crewAIRequest(messages);
  assert.equal(crewAIA2UIAnswersToolResultTurn(request), false);
  assert.equal(crewAIFixture(request), null);
});

test("CrewAI fixed-schema Python tool reports still acknowledge the selected flight", async () => {
  const request: ChatCompletionRequest = {
    model: "gpt-5.4",
    _endpointType: "chat",
    messages: [
      { role: "user", content: "Search for flights from SFO to JFK." },
      {
        role: "tool",
        tool_call_id: "python-action",
        content:
          'User performed action "book_flight" on surface "flight-results" (component: flight). Context: {"flightNumber":"UA 123","origin":"SFO","destination":"JFK","price":"$289"}',
      },
    ],
  };
  assert.deepEqual(await crewAIActionReply(request), {
    content:
      "You are booked on UA 123 from SFO to JFK for $289. Your itinerary is on its way.",
  });
});
