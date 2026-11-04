/**
 * The compatibility boundary's conversion notice, in its own module so the
 * verifier can announce the same conversion without importing the middleware
 * (which would close an import cycle through the agent).
 * @internal
 */
export function warnCompatibility(what: string, replacement: string) {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  )
    return;
  console.warn(
    `[ag-ui][compat] Converting deprecated ${what} to ${replacement}. The old shape leaves the protocol after its shim window — see the repo-root DEPRECATIONS.md. Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`,
  );
}
