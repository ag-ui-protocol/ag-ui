import { headers } from "next/headers";
import { Feature } from "@/types/integration";
import FeatureLayoutClient from "./layout-client";

interface Props {
  params: Promise<{
    integrationId: string;
  }>;
  children: React.ReactNode;
}

export default async function FeatureLayout({ children, params }: Props) {
  const { integrationId } = await params;

  // Get pathname from header (set by middleware)
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") || "";

  // Extract featureId from pathname: /[integrationId]/feature/[featureId]
  const pathParts = pathname.split("/");
  const featureId = pathParts[pathParts.length - 1] as Feature;

  // Note: 404 checks are handled by middleware which returns proper HTTP 404 status

  return (
    <FeatureLayoutClient integrationId={integrationId} featureId={featureId}>
      {children}
    </FeatureLayoutClient>
  );
}
