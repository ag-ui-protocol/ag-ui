import Link from "next/link";

export default function FeatureNotFound() {
  return (
    <div className="flex-1 h-screen w-full flex flex-col items-center justify-center p-8 bg-white rounded-lg">
      <h1 className="text-4xl font-bold text-center mb-4">Feature Not Found</h1>
      <p className="text-muted-foreground mb-6 text-center">
        This feature is not available for the selected integration.
      </p>
      <Link
        href="/"
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
      >
        Back to Home
      </Link>
    </div>
  );
}

