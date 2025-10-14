import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";


export default function RootLayout({ children }: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>
        <CopilotKit
          runtimeUrl="/api/copilotkit"
          agent="agent"
          threadId="491e5c6c-a7a0-46a5-a719-007aca5803b8">
          {children}
        </CopilotKit>
      </body>
    </html>
  );
}