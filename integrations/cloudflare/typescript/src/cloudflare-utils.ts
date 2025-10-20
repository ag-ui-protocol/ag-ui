/**
 * Cloudflare Infrastructure Utilities
 *
 * Handles Cloudflare-specific headers, proxy detection, and request normalization
 * for AG-UI instances running behind Cloudflare CDN or on Cloudflare Workers.
 */

export interface CloudflareHeaders {
  /** Real client IP address (most reliable) */
  "cf-connecting-ip"?: string;
  /** Cloudflare Ray ID for request tracking */
  "cf-ray"?: string;
  /** Visitor's country code */
  "cf-ipcountry"?: string;
  /** True if request came through Cloudflare */
  "cf-visitor"?: string;
  /** Original protocol (http/https) */
  "x-forwarded-proto"?: string;
  /** Chain of proxy IPs */
  "x-forwarded-for"?: string;
  /** True Client IP (Enterprise only) */
  "true-client-ip"?: string;
}

export interface NormalizedRequest {
  /** Real client IP address */
  clientIp: string;
  /** Original protocol */
  protocol: "http" | "https";
  /** Cloudflare Ray ID (if available) */
  rayId?: string;
  /** Client country (if available) */
  country?: string;
  /** Whether request came through Cloudflare */
  isBehindCloudflare: boolean;
  /** Original headers */
  headers: Record<string, string>;
}

/**
 * Detect if a request is behind Cloudflare proxy
 */
export function isBehindCloudflare(headers: Record<string, string>): boolean {
  return !!(headers["cf-ray"] || headers["cf-connecting-ip"] || headers["cf-visitor"]);
}

/**
 * Extract real client IP from Cloudflare headers
 * Priority: CF-Connecting-IP > True-Client-IP > X-Forwarded-For > fallback
 */
export function getClientIP(headers: Record<string, string>, fallbackIp = "unknown"): string {
  // Priority 1: CF-Connecting-IP (most reliable)
  if (headers["cf-connecting-ip"]) {
    return headers["cf-connecting-ip"];
  }

  // Priority 2: True-Client-IP (Enterprise feature)
  if (headers["true-client-ip"]) {
    return headers["true-client-ip"];
  }

  // Priority 3: X-Forwarded-For (first IP in chain)
  if (headers["x-forwarded-for"]) {
    const ips = headers["x-forwarded-for"].split(",");
    return ips[0].trim();
  }

  return fallbackIp;
}

/**
 * Get original protocol from Cloudflare headers
 */
export function getProtocol(headers: Record<string, string>): "http" | "https" {
  // Check CF-Visitor JSON
  if (headers["cf-visitor"]) {
    try {
      const visitor = JSON.parse(headers["cf-visitor"]);
      return visitor.scheme === "https" ? "https" : "http";
    } catch {
      // Malformed CF-Visitor JSON - fall through to other methods
    }
  }

  // Check X-Forwarded-Proto
  if (headers["x-forwarded-proto"]) {
    return headers["x-forwarded-proto"] === "https" ? "https" : "http";
  }

  // Default to https (Cloudflare enforces HTTPS)
  return "https";
}

/**
 * Normalize request from any source to a standard format
 * Works with Node.js Request, Cloudflare Workers Request, or plain headers
 */
export function normalizeRequest(
  request: Request | { headers: Record<string, string | string[]> },
  options?: { fallbackIp?: string },
): NormalizedRequest {
  // Extract headers (works with both Request and plain object)
  const headers: Record<string, string> = {};

  if (request instanceof Request) {
    // Fetch API Request object (Cloudflare Workers, browsers)
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  } else if ("headers" in request) {
    const requestHeaders = request.headers;

    // Check if it's a Headers-like object with .forEach method
    if (typeof (requestHeaders as any).forEach === "function") {
      // Headers object from Fetch API
      (requestHeaders as any).forEach((value: string, key: string) => {
        headers[key.toLowerCase()] = value;
      });
    } else {
      // Plain object with headers (Node.js-style)
      Object.entries(requestHeaders).forEach(([key, value]) => {
        // Handle both string and string[] (Express/Node.js can have arrays)
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        } else if (Array.isArray(value) && value.length > 0) {
          headers[key.toLowerCase()] = value[0];
        }
      });
    }
  }

  const clientIp = getClientIP(headers, options?.fallbackIp);
  const protocol = getProtocol(headers);
  const isBehind = isBehindCloudflare(headers);

  return {
    clientIp,
    protocol,
    rayId: headers["cf-ray"],
    country: headers["cf-ipcountry"],
    isBehindCloudflare: isBehind,
    headers,
  };
}

/**
 * Check if WebSocket upgrade is properly formatted for Cloudflare
 */
export function isWebSocketUpgrade(headers: Record<string, string>): boolean {
  const upgrade = headers["upgrade"]?.toLowerCase();
  const connection = headers["connection"]?.toLowerCase();

  return upgrade === "websocket" && connection?.includes("upgrade");
}

/**
 * Validate WebSocket upgrade request for Cloudflare compatibility
 * Returns error message if invalid, undefined if valid
 */
export function validateWebSocketUpgrade(headers: Record<string, string>): string | undefined {
  if (!isWebSocketUpgrade(headers)) {
    return "Invalid WebSocket upgrade: Missing Upgrade: websocket header";
  }

  // Cloudflare requires Sec-WebSocket-Key
  if (!headers["sec-websocket-key"]) {
    return "Invalid WebSocket upgrade: Missing Sec-WebSocket-Key";
  }

  // Cloudflare requires Sec-WebSocket-Version: 13
  if (headers["sec-websocket-version"] !== "13") {
    return "Invalid WebSocket upgrade: Sec-WebSocket-Version must be 13";
  }

  return undefined;
}

/**
 * Add Cloudflare-specific logging context
 */
export function getLoggingContext(normalized: NormalizedRequest): {
  clientIp: string;
  protocol: "http" | "https";
  rayId?: string;
  country?: string;
  isBehindCloudflare: boolean;
} {
  return {
    clientIp: normalized.clientIp,
    protocol: normalized.protocol,
    rayId: normalized.rayId,
    country: normalized.country,
    isBehindCloudflare: normalized.isBehindCloudflare,
  };
}

/**
 * Create response headers compatible with Cloudflare
 */
export function createResponseHeaders(options?: {
  /** Enable CORS */
  cors?: boolean;
  /** Custom CORS origin */
  corsOrigin?: string;
  /** Cache control */
  cacheControl?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": options?.cacheControl || "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  };

  if (options?.cors) {
    headers["Access-Control-Allow-Origin"] = options.corsOrigin || "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }

  return headers;
}
