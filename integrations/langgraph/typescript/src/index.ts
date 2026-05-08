import { HttpAgent } from "@ag-ui/client";

export * from './agent'
// Transformer is intentionally NOT re-exported from the main entry. It
// imports `@langchain/langgraph` (server-only) and would force every
// consumer (e.g. dojo's Next.js bundle) to resolve that dep. Demo agents
// import it from `@ag-ui/langgraph/transformer` instead.
export class LangGraphHttpAgent extends HttpAgent {}