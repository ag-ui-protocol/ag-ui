import { parseSemanticVersion } from "../utils";

describe("parseSemanticVersion", () => {
  it("parses full semantic versions", () => {
    const parsed = parseSemanticVersion("1.2.3");
    expect(parsed).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
      source: "1.2.3",
    });
    expect(parsed.compare(parsed)).toBe(0);
  });

  it("defaults missing segments to zero", () => {
    expect(parseSemanticVersion("4")).toMatchObject({ major: 4, minor: 0, patch: 0 });
    expect(parseSemanticVersion("4.5")).toMatchObject({ major: 4, minor: 5, patch: 0 });
  });

  it("parses prerelease and build metadata", () => {
    const parsed = parseSemanticVersion("2.0.1-alpha.1+build.5");
    expect(parsed).toMatchObject({
      major: 2,
      minor: 0,
      patch: 1,
      prerelease: ["alpha", "1"],
      build: ["build", "5"],
      source: "2.0.1-alpha.1+build.5",
    });
    expect(parsed.compare(parseSemanticVersion("2.0.1-alpha.2"))).toBeLessThan(0);
  });

  it("rejects non-semantic labels like latest", () => {
    expect(() => parseSemanticVersion("latest")).toThrow();
    expect(() => parseSemanticVersion("LaTeSt")).toThrow();
  });

  it("throws on invalid versions", () => {
    expect(() => parseSemanticVersion("not-a-version")).toThrow();
    expect(() => parseSemanticVersion("")).toThrow();
  });
});
