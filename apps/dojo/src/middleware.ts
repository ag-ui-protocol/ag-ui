import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isFeatureAvailable, isIntegrationValid } from "./integration-features";

function create404Response(title: string, message: string): NextResponse {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f9fafb;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 2.25rem;
      font-weight: bold;
      margin-bottom: 1rem;
      color: #111827;
    }
    p {
      color: #6b7280;
      margin-bottom: 1.5rem;
    }
    a {
      display: inline-block;
      padding: 0.5rem 1rem;
      background: #111827;
      color: white;
      text-decoration: none;
      border-radius: 0.375rem;
      transition: background 0.2s;
    }
    a:hover {
      background: #374151;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">Back to Home</a>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html",
    },
  });
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Check for feature routes: /[integrationId]/feature/[featureId]
  const featureMatch = pathname.match(/^\/([^/]+)\/feature\/([^/]+)\/?$/);

  if (featureMatch) {
    const [, integrationId, featureId] = featureMatch;

    // Check if integration exists
    if (!isIntegrationValid(integrationId)) {
      return create404Response(
        "Integration Not Found",
        "The integration you're looking for doesn't exist."
      );
    }

    // Check if feature is available for this integration
    if (!isFeatureAvailable(integrationId, featureId)) {
      return create404Response(
        "Feature Not Found",
        "This feature is not available for the selected integration."
      );
    }
  }

  // Check for integration routes: /[integrationId] (but not /[integrationId]/feature/...)
  const integrationMatch = pathname.match(/^\/([^/]+)\/?$/);

  if (integrationMatch) {
    const [, integrationId] = integrationMatch;

    // Skip the root path
    if (integrationId && integrationId !== "") {
      if (!isIntegrationValid(integrationId)) {
        return create404Response(
          "Integration Not Found",
          "The integration you're looking for doesn't exist."
        );
      }
    }
  }

  // Clone the request headers and set the pathname for downstream use
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

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

