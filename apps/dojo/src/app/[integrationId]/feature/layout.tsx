import { headers } from "next/headers";
import { notFound } from "next/navigation";
import FeatureLayoutClient from "./layout-client";

// Force dynamic rendering to ensure proper 404 handling
export const dynamic = "force-dynamic";

interface Props {
  children: React.ReactNode;
}

export default async function FeatureLayout({ children }: Props) {
  // Get headers set by proxy
  const headersList = await headers();
  const notFoundType = headersList.get("x-not-found");

  // If proxy flagged this as not found, trigger 404
  if (notFoundType) {
    notFound();
  }

  return (
    <FeatureLayoutClient>
      {children}
    </FeatureLayoutClient>
  );
}
