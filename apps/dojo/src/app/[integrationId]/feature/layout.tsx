import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Feature } from "@/types/integration";
import FeatureLayoutClient from "./layout-client";

// Force dynamic rendering to ensure proper 404 handling
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{
    integrationId: string;
  }>;
  children: React.ReactNode;
}

export default async function FeatureLayout({ children, params }: Props) {
  const { integrationId } = await params;

  // Get headers set by proxy
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") || "";
  const notFoundType = headersList.get("x-not-found");

  // If proxy flagged this as not found, trigger 404
  if (notFoundType) {
    notFound();
  }

  // Extract featureId from pathname: /[integrationId]/feature/[featureId]
  const pathParts = pathname.split("/");
  const featureId = pathParts[pathParts.length - 1] as Feature;

  return (
    <FeatureLayoutClient integrationId={integrationId} featureId={featureId}>
      {children}
    </FeatureLayoutClient>
  );
}
