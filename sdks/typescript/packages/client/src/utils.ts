import { v4 as uuidv4 } from "uuid";

export const structuredClone_ = <T>(obj: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (err) {
    return { ...obj } as T;
  }
};

/**
 * Generate a random UUID v4
 * Cross-platform compatible (Node.js, browsers, React Native)
 */
export function randomUUID(): string {
  return uuidv4();
}

export interface ParsedSemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  source: string;
}

const SEMVER_PATTERN =
  /^(?<major>0|[1-9]\d*)(?:\.(?<minor>0|[1-9]\d*)(?:\.(?<patch>0|[1-9]\d*))?)?(?:-(?<prerelease>(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parses a semantic version string into its numeric components.
 * Supports incomplete versions (e.g. "1", "1.2") by defaulting missing segments to zero.
 *
 * @throws If the version string is not a valid semantic version.
 */
export function parseSemanticVersion(version: string): ParsedSemanticVersion {
  const trimmed = version.trim();

  if (trimmed.length === 0) {
    throw new Error("Semantic version cannot be empty");
  }

  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match || !match.groups?.major) {
    throw new Error(`Invalid semantic version: "${version}"`);
  }

  const major = Number.parseInt(match.groups.major, 10);
  const minor = match.groups.minor ? Number.parseInt(match.groups.minor, 10) : 0;
  const patch = match.groups.patch ? Number.parseInt(match.groups.patch, 10) : 0;
  const prerelease = match.groups.prerelease ? match.groups.prerelease.split(".") : [];
  const build = match.groups.build ? match.groups.build.split(".") : [];

  return {
    major,
    minor,
    patch,
    prerelease,
    build,
    source: version,
  };
}
