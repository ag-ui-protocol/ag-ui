# A2A Middleware

`@ag-ui/a2a-middleware` provides `A2AMiddlewareAgent`, which delegates tool calls
from an AG-UI orchestration agent to remote A2A agents. It uses `@a2a-js/sdk` to
send requests and converts message or task replies into AG-UI tool events.

## Runtime dependencies

The middleware previously declared `ai` as a runtime dependency despite not
using it in its source, published JavaScript, or type declarations. Removing
that dependency stops this package from pulling in the AI SDK 4 dependency tree,
including `@ai-sdk/ui-utils` and `@ai-sdk/provider-utils` 2.x.

`@a2a-js/sdk` and `zod` remain runtime dependencies; `@ag-ui/client` and `rxjs`
are peer dependencies. Supply an `orchestrationAgent` as before, and install
any provider or integration dependencies that agent requires. Other workspace
integrations can still depend on the AI SDK independently.

## Validation

Run the package checks from the repository root:

```sh
pnpm exec nx run @ag-ui/a2a-middleware:build
pnpm exec nx run @ag-ui/a2a-middleware:typecheck
pnpm exec nx run @ag-ui/a2a-middleware:test
pnpm exec nx run @ag-ui/a2a-middleware:test:exports
```

Dependency removal is also checked with packed tarballs in clean production
consumers using both CommonJS and ESM. Local mocks cover A2A request and reply
conversion, streaming, and error handling; these checks do not call live agents
or model providers.

## Tutorial

To learn how to set up your own middleware server, please refer to the [tutorial](https://docs.ag-ui.com/quickstart/middleware).
