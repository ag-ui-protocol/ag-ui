import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Agent SDK + CopilotKit Demo",
  description: "Integration of Claude Agent SDK with CopilotKit using AG-UI Protocol",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

