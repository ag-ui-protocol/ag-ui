import type { MiddlewareFunction } from "@ag-ui/client";

/** Keep CopilotKit's transport correlation ID out of Codex host overrides. */
export const codexRequestMetadata: MiddlewareFunction = (input, next) => {
  const props: unknown = input.forwardedProps;
  if (
    props === null ||
    typeof props !== "object" ||
    Array.isArray(props) ||
    !("__copilotkitRequestId" in props) ||
    typeof props.__copilotkitRequestId !== "string"
  ) {
    return next.run(input);
  }
  const forwardedProps = { ...props };
  delete forwardedProps.__copilotkitRequestId;
  return next.run({ ...input, forwardedProps });
};
