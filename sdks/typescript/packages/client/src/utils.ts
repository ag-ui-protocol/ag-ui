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
  compare(other: ParsedSemanticVersion): number;
}

const SEMVER_PATTERN =
  /^(?<major>0|[1-9]\d*)(?:\.(?<minor>0|[1-9]\d*)(?:\.(?<patch>0|[1-9]\d*))?)?(?:-(?<prerelease>(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

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

  const parsed: ParsedSemanticVersion = {
    major,
    minor,
    patch,
    prerelease,
    build,
    source: version,
    compare(this: ParsedSemanticVersion, other: ParsedSemanticVersion): number {
      if (this.major !== other.major) {
        return this.major - other.major;
      }

      if (this.minor !== other.minor) {
        return this.minor - other.minor;
      }

      if (this.patch !== other.patch) {
        return this.patch - other.patch;
      }

      if (this.prerelease.length === 0 && other.prerelease.length === 0) {
        return 0;
      }

      if (this.prerelease.length === 0) {
        return 1;
      }

      if (other.prerelease.length === 0) {
        return -1;
      }

      const length = Math.max(this.prerelease.length, other.prerelease.length);
      for (let index = 0; index < length; index++) {
        const aIdentifier = this.prerelease[index];
        const bIdentifier = other.prerelease[index];

        if (aIdentifier === undefined) {
          return -1;
        }

        if (bIdentifier === undefined) {
          return 1;
        }

        const aIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(aIdentifier);
        const bIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(bIdentifier);

        if (aIsNumeric && bIsNumeric) {
          const diff = Number(aIdentifier) - Number(bIdentifier);
          if (diff !== 0) {
            return diff;
          }
          continue;
        }

        if (aIsNumeric) {
          return -1;
        }

        if (bIsNumeric) {
          return 1;
        }

        const lexicalComparison = aIdentifier.localeCompare(bIdentifier);
        if (lexicalComparison !== 0) {
          return lexicalComparison;
        }
      }

      return 0;
    },
  };

  return parsed;
}
