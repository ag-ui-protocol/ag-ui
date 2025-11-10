import { routeAgentRequest } from "agents";
import "./agent"; // registers MyAgent

type Env = {};

export default {
  fetch(req: Request, env: Env) {
    return (
      routeAgentRequest(req, env) ?? new Response("Not found", { status: 404 })
    );
  },
};
