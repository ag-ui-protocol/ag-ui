/**
 * Tests for WatsonxAgent constructor validation and configuration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WatsonxAgent } from "../index";

describe("WatsonxAgent constructor", () => {
  it("throws when neither apiKey nor bearerToken is provided", () => {
    expect(
      () =>
        new WatsonxAgent({
          region: "us-south",
          instanceId: "inst-1",
          agentId: "agent-1",
        }),
    ).toThrow("requires either apiKey or bearerToken");
  });

  it("accepts apiKey only", () => {
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "agent-1",
      apiKey: "my-api-key",
    });
    expect(agent).toBeInstanceOf(WatsonxAgent);
  });

  it("accepts bearerToken only", () => {
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "agent-1",
      bearerToken: "pre-exchanged-token",
    });
    expect(agent).toBeInstanceOf(WatsonxAgent);
  });

  it("accepts both apiKey and bearerToken", () => {
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "agent-1",
      apiKey: "my-api-key",
      bearerToken: "pre-exchanged-token",
    });
    expect(agent).toBeInstanceOf(WatsonxAgent);
  });

  it("constructs correct baseUrl from region and instanceId", () => {
    const agent = new WatsonxAgent({
      region: "eu-de",
      instanceId: "my-inst-42",
      agentId: "agent-1",
      apiKey: "key",
    });
    // baseUrl is a private getter — test it indirectly by observing the
    // fetch URL in a run. For unit-level check, access via any cast.
    const baseUrl = (agent as any).baseUrl;
    expect(baseUrl).toBe(
      "https://api.eu-de.watson-orchestrate.cloud.ibm.com/instances/my-inst-42",
    );
  });

  it("sets tokenExpiresAt ~55 minutes in the future when bearerToken is provided", () => {
    const before = Date.now();
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "agent-1",
      bearerToken: "tok",
    });
    const after = Date.now();

    const expiresAt = (agent as any).tokenExpiresAt as number;
    // Should be approximately 55 minutes from now
    const expectedMin = before + 55 * 60 * 1000;
    const expectedMax = after + 55 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("sets tokenExpiresAt to 0 when only apiKey is provided", () => {
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "agent-1",
      apiKey: "key",
    });
    const expiresAt = (agent as any).tokenExpiresAt as number;
    expect(expiresAt).toBe(0);
  });

  it("stores agentId on the AbstractAgent base class", () => {
    const agent = new WatsonxAgent({
      region: "us-south",
      instanceId: "inst-1",
      agentId: "my-agent-id",
      apiKey: "key",
    });
    expect(agent.agentId).toBe("my-agent-id");
  });
});
