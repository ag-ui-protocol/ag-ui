import { timingSafeEqual } from "node:crypto";

export function authorizeGuidance(
  authorization: string | null,
  settings: { token?: string; restrictedIngress?: boolean },
): "trusted" | "ordinary" | "reject" {
  if (!settings.token)
    return settings.restrictedIngress ? "trusted" : "ordinary";

  const expected = Buffer.from(`Bearer ${settings.token}`);
  const offered = Buffer.from(authorization ?? "");
  return offered.length === expected.length &&
    timingSafeEqual(offered, expected)
    ? "trusted"
    : "reject";
}
