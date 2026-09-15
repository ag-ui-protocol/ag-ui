import type { ProxiedMCPRequest } from "./index";

const hashOnlyRequest: ProxiedMCPRequest = {
  serverHash: "server-hash",
  method: "ping",
};

const idOnlyRequest: ProxiedMCPRequest = {
  serverId: "server-id",
  method: "ping",
};

const requestWithBothIdentifiers: ProxiedMCPRequest = {
  serverHash: "server-hash",
  serverId: "server-id",
  method: "ping",
};

// @ts-expect-error Proxied requests need either serverId or serverHash.
const requestWithoutIdentifier: ProxiedMCPRequest = {
  method: "ping",
};

void hashOnlyRequest;
void idOnlyRequest;
void requestWithBothIdentifiers;
void requestWithoutIdentifier;
