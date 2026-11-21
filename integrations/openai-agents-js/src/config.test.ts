import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpenAIAgentsAdapter,
  OpenAIAgentsConfigError,
} from "./adapter";
import { DEFAULT_MODEL, ENV } from "./config";

describe("OpenAIAgentsAdapter — config resolution (V9, V10, V12)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clean env between tests so resolution is deterministic.
    delete process.env[ENV.API_KEY];
    delete process.env[ENV.BASE_URL];
    delete process.env[ENV.MODEL];
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe("V9 — model default + override", () => {
    it("defaults to the gpt-5 family when no model provided", () => {
      const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
      expect(adapter["resolveModel"]()).toBe(DEFAULT_MODEL);
      expect(DEFAULT_MODEL).toMatch(/^gpt-5/);
    });

    it("honors an explicit model override", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        model: "gpt-5-mini",
      });
      expect(adapter["resolveModel"]()).toBe("gpt-5-mini");
    });

    it("falls back to OPENAI_MODEL env var", () => {
      process.env[ENV.MODEL] = "gpt-5.1";
      const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
      expect(adapter["resolveModel"]()).toBe("gpt-5.1");
    });

    it("prefers explicit config over env var", () => {
      process.env[ENV.MODEL] = "gpt-5.1";
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        model: "gpt-5-mini",
      });
      expect(adapter["resolveModel"]()).toBe("gpt-5-mini");
    });
  });

  describe("V10 — OPENAI_API_KEY required", () => {
    it("throws a clear error when no key is configured or in env", () => {
      const adapter = new OpenAIAgentsAdapter({});
      expect(() => adapter["resolveApiKey"]()).toThrow(OpenAIAgentsConfigError);
      expect(() => adapter["resolveApiKey"]()).toThrow(
        /OPENAI_API_KEY/,
      );
    });

    it("resolves when key is passed via config", () => {
      const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
      expect(adapter["resolveApiKey"]()).toBe("sk-test");
    });

    it("resolves when key is set via env var", () => {
      process.env[ENV.API_KEY] = "sk-env";
      const adapter = new OpenAIAgentsAdapter({});
      expect(adapter["resolveApiKey"]()).toBe("sk-env");
    });
  });

  describe("V12 — LiteLLM-compatible config path", () => {
    it("resolves baseURL from config", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        baseURL: "https://litellm.example.com/v1",
      });
      expect(adapter["resolveBaseUrl"]()).toBe(
        "https://litellm.example.com/v1",
      );
    });

    it("resolves baseURL from OPENAI_BASE_URL env var", () => {
      process.env[ENV.BASE_URL] = "https://litellm.example.com/v1";
      const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
      expect(adapter["resolveBaseUrl"]()).toBe(
        "https://litellm.example.com/v1",
      );
    });

    it("returns undefined when no baseURL is configured", () => {
      const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
      expect(adapter["resolveBaseUrl"]()).toBeUndefined();
    });

    it("throws when openAIClient is combined with baseURL", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        baseURL: "https://litellm.example.com/v1",
        openAIClient: {},
      });
      expect(() => adapter["validateConfig"]()).toThrow(OpenAIAgentsConfigError);
      expect(() => adapter["validateConfig"]()).toThrow(/cannot be combined/);
    });

    it("throws when openAIClient is combined with apiKey", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        openAIClient: {},
      });
      expect(() => adapter["validateConfig"]()).toThrow(/cannot be combined/);
    });

    it("accepts openAIClient on its own", () => {
      const adapter = new OpenAIAgentsAdapter({ openAIClient: {} });
      expect(() => adapter["validateConfig"]()).not.toThrow();
    });

    it("accepts baseURL + apiKey without openAIClient", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        baseURL: "https://litellm.example.com/v1",
      });
      expect(() => adapter["validateConfig"]()).not.toThrow();
    });
  });

  describe("clone", () => {
    it("clones the adapter and its config", () => {
      const adapter = new OpenAIAgentsAdapter({
        apiKey: "sk-test",
        model: "gpt-5-mini",
      });
      const cloned = adapter.clone();
      expect(cloned).not.toBe(adapter);
      expect(cloned["resolveModel"]()).toBe("gpt-5-mini");
      // Mutating cloned config must not affect the original.
      cloned["config"].model = "gpt-5";
      expect(adapter["resolveModel"]()).toBe("gpt-5-mini");
    });
  });
});
