import fs from "fs";
import path from "path";
import { menuIntegrations } from "../src/menu";

// Map menuIntegrations to the format needed for content generation
const agentConfigs = menuIntegrations.map((integration) => ({
  id: integration.id,
  agentKeys: [...integration.features],
}));

const featureFiles = ["page.tsx", "style.css", "README.mdx"];

async function getFile(_filePath: string | undefined, _fileName?: string) {
  if (!_filePath) {
    console.warn(`File path is undefined, skipping.`);
    return {};
  }

  const fileName = _fileName ?? _filePath.split("/").pop() ?? "";
  const filePath = _fileName ? path.join(_filePath, fileName) : _filePath;

  // Check if it's a remote URL
  const isRemoteUrl =
    _filePath.startsWith("http://") || _filePath.startsWith("https://");

  let content: string;

  try {
    if (isRemoteUrl) {
      // Convert GitHub URLs to raw URLs for direct file access
      let fetchUrl = _filePath;
      if (_filePath.includes("github.com") && _filePath.includes("/blob/")) {
        fetchUrl = _filePath
          .replace("github.com", "raw.githubusercontent.com")
          .replace("/blob/", "/");
      }

      // Fetch remote file content
      console.log(`Fetching remote file: ${fetchUrl}`);
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        console.warn(
          `Failed to fetch remote file: ${fetchUrl}, status: ${response.status}`,
        );
        return {};
      }
      content = await response.text();
    } else {
      // Handle local file
      if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}, skipping.`);
        return {};
      }
      content = fs.readFileSync(filePath, "utf8");
    }

    const extension = fileName.split(".").pop();
    let language = extension;
    if (extension === "py") language = "python";
    else if (extension === "cs") language = "csharp";
    else if (extension === "css") language = "css";
    else if (extension === "md" || extension === "mdx") language = "markdown";
    else if (extension === "tsx") language = "typescript";
    else if (extension === "js") language = "javascript";
    else if (extension === "json") language = "json";
    else if (extension === "yaml" || extension === "yml") language = "yaml";
    else if (extension === "toml") language = "toml";

    return {
      name: fileName,
      content,
      language,
      type: "file",
    };
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return {};
  }
}

async function getFeatureFrontendFiles(featureId: string) {
  const featurePath = path.join(
    __dirname,
    `../src/app/[integrationId]/feature/${featureId as string}`,
  );
  const retrievedFiles = [];

  for (const fileName of featureFiles) {
    retrievedFiles.push(await getFile(featurePath, fileName));
  }

  return retrievedFiles;
}

const integrationsFolderPath = "../../../integrations";
const middlewaresFolderPath = "../../../middlewares";
const agentFilesMapper: Record<
  string,
  (agentKeys: string[]) => Record<string, string[]>
> = {
  "middleware-starter": () => ({
    agentic_chat: [
      path.join(
        __dirname,
        middlewaresFolderPath,
        `/middleware-starter/src/index.ts`,
      ),
    ],
  }),
  "pydantic-ai": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/pydantic-ai/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "server-starter": () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/server-starter/python/examples/example_server/__init__.py`,
      ),
    ],
  }),
  "server-starter-all-features": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/server-starter-all-features/python/examples/example_server/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  mastra: () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/agentic-chat.ts`,
      ),
    ],
    backend_tool_rendering: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/backend-tool-rendering.ts`,
      ),
    ],
    human_in_the_loop: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/human-in-the-loop.ts`,
      ),
    ],
    tool_based_generative_ui: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/tool-based-generative-ui.ts`,
      ),
    ],
  }),

  "mastra-agent-local": () => ({
    agentic_chat: [path.join(__dirname, "../src/mastra/agents/agentic-chat.ts")],
    human_in_the_loop: [path.join(__dirname, "../src/mastra/agents/human-in-the-loop.ts")],
    backend_tool_rendering: [path.join(__dirname, "../src/mastra/agents/backend-tool-rendering.ts")],
    shared_state: [path.join(__dirname, "../src/mastra/agents/shared-state.ts")],
    tool_based_generative_ui: [path.join(__dirname, "../src/mastra/agents/tool-based-generative-ui.ts")],
  }),

  "vercel-ai-sdk": () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/vercel-ai-sdk/src/index.ts`,
      ),
    ],
  }),

  langgraph: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/typescript/examples/src/agents/${agentId}/agent.ts`,
          ),
        ],
      }),
      {},
    );
  },
  "langgraph-typescript": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/typescript/examples/src/agents/${agentId}/agent.ts`,
          ),
        ],
      }),
      {},
    );
  },
  "langgraph-fastapi": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
        ],
      }),
      {},
    );
  },
  "spring-ai": () => ({}),
  agno: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/agno/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "llama-index": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/llama-index/python/examples/server/routers/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  crewai: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/crew-ai/python/ag_ui_crewai/examples/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "adk-middleware": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/adk-middleware/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "aws-strands": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/aws-strands/python/examples/server/api/${agentId}.py`,
          )
        ],
      }),
      {},
    );
  },
  "microsoft-agent-framework-python": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/python/examples/agents/dojo.py`,
          ),
        ],
      }),
      {},
    );
  },
  "microsoft-agent-framework-dotnet": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/ChatClientAgentFactory.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/SharedStateAgent.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/Program.cs`,
          ),
        ],
      }),
      {},
    );
  },
};

async function runGenerateContent() {
  const result = {};
  for (const agentConfig of agentConfigs) {
    // Use the parsed agent keys instead of executing the agents function
    const agentsPerFeatures = agentConfig.agentKeys;

    const agentFilePaths = agentFilesMapper[agentConfig.id]?.(
      agentConfig.agentKeys,
    );

    console.log(agentConfig.id, agentFilePaths);
    if (!agentFilePaths) {
      continue;
    }

    // If agentsPerFeatures is empty but we have agentFilePaths, use the keys from agentFilePaths
    // This handles cases like Mastra where agents are dynamically discovered
    const featureIds = agentsPerFeatures.length > 0
      ? agentsPerFeatures
      : Object.keys(agentFilePaths);

    // Per feature, assign all the frontend files like page.tsx as well as all agent files
    for (const featureId of featureIds) {
      const agentFilePathsForFeature = agentFilePaths[featureId] ?? [];
      // @ts-expect-error -- redundant error about indexing of a new object.
      result[`${agentConfig.id}::${featureId}`] = [
        // Get all frontend files for the feature
        ...(await getFeatureFrontendFiles(featureId)),
        // Get the agent (python/TS) file
        ...(await Promise.all(
          agentFilePathsForFeature.map(async (f) => await getFile(f)),
        )),
      ];
    }
  }

  return result;
}

(async () => {
  const result = await runGenerateContent();
  fs.writeFileSync(
    path.join(__dirname, "../src/files.json"),
    JSON.stringify(result, null, 2),
  );

  console.log("Successfully generated src/files.json");
})();
