## ADR‑0020: Engram A2A Extension URI & Activation

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

Engram is defined as an A2A extension. Other extensions (e.g., Secure Passport, AP2) follow common patterns for:

* How the extension is **identified** (canonical URI with an embedded version),
* How agents **advertise support** in their AgentCards, and
* How clients **activate** extensions on individual requests using the `X-A2A-Extensions` header.

Engram v0.1 should follow the same patterns so it composes cleanly with other extensions and is discoverable by generic tooling.

### Decision

1. **Canonical extension URI for Engram v0.1**

   * The A2A extension URI for Engram v0.1 is:

   ```text
   https://github.com/EmberAGI/a2a-engram/tree/v0.1
   ```

   * This URI uniquely identifies Engram v0.1. Any **backwards‑incompatible** change to the Engram wire format or semantics MUST use a new URI (e.g. `/tree/v0.2`).

2. **Advertising Engram support in AgentCards**

   * Agents that implement Engram v0.1 MUST list the above URI in their `AgentCapabilities.extensions` list in the AgentCard.
   * Engram v0.1 does not require any structured parameters; implementations MAY include a `params` object for extension‑specific configuration, but no standard fields are defined yet.

   Example:

   ```jsonc
   {
     "name": "Engram-aware Agent",
     "capabilities": {
       "extensions": [
         {
           "uri": "https://github.com/EmberAGI/a2a-engram/tree/v0.1",
           "description": "Supports Engram domain state and subscriptions"
         }
       ]
     }
   }
   ```

3. **Activation via `X-A2A-Extensions` header**

   * Clients that wish to use Engram MUST request activation by including the Engram URI in the `X-A2A-Extensions` header on any request that depends on Engram semantics (e.g. `engram/*`, `message/*` that embed Engram ops, or `tasks/*` interacting with Engram subscription Tasks):

   ```http
   X-A2A-Extensions: https://github.com/EmberAGI/a2a-engram/tree/v0.1
   ```

   * Servers that support Engram SHOULD echo the active extension URI in the response `X-A2A-Extensions` header as per the A2A extensions guidelines.
   * If Engram is required for correct handling of a request and the extension is not requested or not supported, servers MAY reject the request with an appropriate error.

4. **Versioning and compatibility**

   * Different Engram versions MUST use different URIs. Clients and servers MUST NOT assume that distinct URIs are wire‑compatible.
   * Minor, backwards‑compatible clarifications to v0.1 may be made without changing the URI, but any change that affects:

     * method names or parameter shapes,
     * `EngramEvent` wire format, or
     * observable behaviors required by the spec

     MUST be released under a new versioned URI.

### Consequences

* Engram v0.1 fits neatly into the existing A2A extension model.
* Generic tooling can:

  * Discover Engram support via AgentCards,
  * See which requests activated Engram via `X-A2A-Extensions`, and
  * Reason about compatibility based on the URI alone.
* The versioned URI gives Engram a clear evolution path (v0.2, v1, e
