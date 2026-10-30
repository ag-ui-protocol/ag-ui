import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Hex SHA-256 of a UTF-8 string. Byte-identical to Node's
 * `createHash("sha256").update(input).digest("hex")`, but runs on edge
 * runtimes without `node:crypto` and stays synchronous.
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}
