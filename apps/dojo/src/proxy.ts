import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isIntegrationValid, isFeatureAvailable } from "./utils/menu";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  // Check for feature routes: /[integrationId]/feature/[featureId]
  const featureMatch = pathname.match(/^\/([^/]+)\/feature\/([^/]+)\/?$/);

  if (featureMatch) {
    const [, integrationId, featureId] = featureMatch;

    // Check if integration exists
    if (!isIntegrationValid(integrationId)) {
      requestHeaders.set("x-not-found", "integration");
    }
    // Check if feature is available for this integration
    else if (!isFeatureAvailable(integrationId, featureId)) {
      requestHeaders.set("x-not-found", "feature");
    }
  }

  // Check for integration routes: /[integrationId] (but not /[integrationId]/feature/...)
  const integrationMatch = pathname.match(/^\/([^/]+)\/?$/);

  if (integrationMatch) {
    const [, integrationId] = integrationMatch;

    // Skip the root path
    if (integrationId && integrationId !== "") {
      if (!isIntegrationValid(integrationId)) {
        requestHeaders.set("x-not-found", "integration");
      }
    }
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    // Match all paths except static files and api routes
    "/((?!api|_next/static|_next/image|favicon.ico|images).*)",
  ],
};

