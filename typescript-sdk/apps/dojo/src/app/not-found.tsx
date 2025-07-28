"use client";

import React, { Suspense } from "react";
import Link from "next/link";

function NotFoundContent() {
  return (
    <div className="flex-1 h-screen w-full flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-center mb-4">Page Not Found</h1>
      <p className="text-muted-foreground mb-6 text-center">
        The page you&apos;re looking for doesn&apos;t exist.
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

export default function NotFound() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotFoundContent />
    </Suspense>
  );
} 