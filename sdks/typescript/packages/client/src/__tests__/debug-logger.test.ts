import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebugLogger, createDebugLogger } from "@/debug-logger";
import { resolveAgentDebugConfig, ResolvedAgentDebugConfig } from "@/agent/types";

describe("resolveAgentDebugConfig", () => {
  it("undefined -> all fields false", () => {
    const result = resolveAgentDebugConfig(undefined);
    expect(result).toEqual({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    });
  });

  it("false -> all fields false", () => {
    const result = resolveAgentDebugConfig(false);
    expect(result).toEqual({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    });
  });

  it("true -> all fields true", () => {
    const result = resolveAgentDebugConfig(true);
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
  });

  it("{} -> events true, lifecycle true, verbose false, enabled true", () => {
    const result = resolveAgentDebugConfig({});
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
  });

  it("{ events: true } -> events true, lifecycle true (default), verbose false", () => {
    const result = resolveAgentDebugConfig({ events: true });
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
  });

  it("{ events: false } -> events false, lifecycle true, verbose false", () => {
    const result = resolveAgentDebugConfig({ events: false });
    expect(result).toEqual({
      enabled: true,
      events: false,
      lifecycle: true,
      verbose: false,
    });
  });

  it("{ lifecycle: false } -> events true, lifecycle false, verbose false", () => {
    const result = resolveAgentDebugConfig({ lifecycle: false });
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: false,
      verbose: false,
    });
  });

  it("{ verbose: true } -> events true, lifecycle true, verbose true", () => {
    const result = resolveAgentDebugConfig({ verbose: true });
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
  });

  it("{ events: false, lifecycle: false } -> enabled false", () => {
    const result = resolveAgentDebugConfig({
      events: false,
      lifecycle: false,
    });
    expect(result).toEqual({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    });
  });

  it("{ events: false, lifecycle: false, verbose: true } -> enabled false (verbose alone doesn't enable)", () => {
    const result = resolveAgentDebugConfig({
      events: false,
      lifecycle: false,
      verbose: true,
    });
    expect(result).toEqual({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: true,
    });
  });

  it("{ events: true, lifecycle: false, verbose: true } -> enabled true", () => {
    const result = resolveAgentDebugConfig({
      events: true,
      lifecycle: false,
      verbose: true,
    });
    expect(result).toEqual({
      enabled: true,
      events: true,
      lifecycle: false,
      verbose: true,
    });
  });
});

describe("createDebugLogger", () => {
  it("returns undefined when config has enabled: false", () => {
    const config: ResolvedAgentDebugConfig = {
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    };
    expect(createDebugLogger(config)).toBeUndefined();
  });

  it("returns DebugLogger instance when config has enabled: true", () => {
    const config: ResolvedAgentDebugConfig = {
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    };
    const logger = createDebugLogger(config);
    expect(logger).toBeInstanceOf(DebugLogger);
  });
});

describe("DebugLogger.event()", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT call console.debug when events is disabled", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: false,
      lifecycle: true,
      verbose: false,
    });
    logger.event("PREFIX", "some label", { foo: "bar" });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("calls console.debug with [PREFIX] label and JSON.stringify(data) when verbose is true", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
    const data = { type: "TEST", value: 42 };
    logger.event("PREFIX", "some label", data);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label", JSON.stringify(data));
  });

  it("calls console.debug with [PREFIX] label and summary object when verbose is false and summary provided", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
    const data = { type: "TEST", value: 42, bigPayload: "lots of data" };
    const summary = { type: "TEST" };
    logger.event("PREFIX", "some label", data, summary);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label", summary);
  });

  it("calls console.debug with [PREFIX] label and raw data when verbose is false and no summary provided", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
    const data = { type: "TEST", value: 42 };
    logger.event("PREFIX", "some label", data);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label", data);
  });

  it("handles string data correctly in verbose mode (no double-stringify)", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
    const data = "just a string";
    logger.event("PREFIX", "some label", data);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    // String data should be passed directly, not JSON.stringify'd
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label", "just a string");
  });
});

describe("DebugLogger.lifecycle()", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT call console.debug when lifecycle is disabled", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: false,
      verbose: false,
    });
    logger.lifecycle("PREFIX", "some label", { key: "value" });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("calls console.debug with [PREFIX] label and data when data provided", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
    const data = { agentId: "agent-1", threadId: "thread-1" };
    logger.lifecycle("PREFIX", "some label", data);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label", data);
  });

  it("calls console.debug with [PREFIX] label only when no data provided", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
    logger.lifecycle("PREFIX", "some label");
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[PREFIX] some label");
  });
});

describe("DebugLogger getters", () => {
  it("enabled returns config.enabled", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: false,
      lifecycle: false,
      verbose: false,
    });
    expect(logger.enabled).toBe(true);

    const logger2 = new DebugLogger({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    });
    expect(logger2.enabled).toBe(false);
  });

  it("eventsEnabled returns config.events", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: false,
      verbose: false,
    });
    expect(logger.eventsEnabled).toBe(true);

    const logger2 = new DebugLogger({
      enabled: true,
      events: false,
      lifecycle: true,
      verbose: false,
    });
    expect(logger2.eventsEnabled).toBe(false);
  });

  it("lifecycleEnabled returns config.lifecycle", () => {
    const logger = new DebugLogger({
      enabled: true,
      events: false,
      lifecycle: true,
      verbose: false,
    });
    expect(logger.lifecycleEnabled).toBe(true);

    const logger2 = new DebugLogger({
      enabled: true,
      events: true,
      lifecycle: false,
      verbose: false,
    });
    expect(logger2.lifecycleEnabled).toBe(false);
  });
});
