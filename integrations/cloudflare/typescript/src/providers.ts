import { CloudflareAGUIAdapter, CloudflareAGUIAdapterOptions } from "./adapter";
import { CloudflareModel } from "./types";

export interface ProviderConfig extends Omit<CloudflareAGUIAdapterOptions, "model"> {
  model?: CloudflareModel;
}

export class CloudflareProviders {
  /**
   * Helper to create adapter with specific model
   */
  private static createAdapter(config: ProviderConfig, defaultModel: CloudflareModel): CloudflareAGUIAdapter {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || defaultModel,
    });
  }

  // Llama 3.1 series - General purpose, fast inference

  /**
   * Llama 3.1 8B - Fast, general purpose
   * - Context: 128K tokens
   * - Function calling: No
   * - Best for: Quick responses, general chat
   */
  static llama3_8b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/meta/llama-3.1-8b-instruct");
  }

  /**
   * Llama 3.1 70B - Powerful, general purpose
   * - Context: 128K tokens
   * - Function calling: No
   * - Best for: Complex reasoning, detailed responses
   */
  static llama3_70b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/meta/llama-3.1-70b-instruct");
  }

  // Llama 3.3 series - Function calling support

  /**
   * Llama 3.3 70B (FP8 Fast) - Function calling capable
   * - Context: 128K tokens
   * - Function calling: Yes
   * - Best for: Tool use, structured outputs
   */
  static llama3_3_70b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  }

  // Llama 4 series - Latest generation

  /**
   * Llama 4 Scout 17B - Latest generation with function calling
   * - Context: 128K tokens
   * - Function calling: Yes
   * - Best for: Latest features, balanced performance
   */
  static llama4Scout17b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/meta/llama-4-scout-17b-16e-instruct");
  }

  // Mistral series

  /**
   * Mistral 7B - Fast, efficient
   * - Context: 32K tokens
   * - Function calling: No
   * - Best for: Quick responses, cost efficiency
   */
  static mistral7b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/mistral/mistral-7b-instruct-v0.2");
  }

  /**
   * Mistral Small 24B - Function calling capable
   * - Context: 32K tokens
   * - Function calling: Yes
   * - Best for: Tool use with faster inference than 70B models
   */
  static mistralSmall24b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/mistralai/mistral-small-3.1-24b-instruct");
  }

  // Hermes series

  /**
   * Hermes 2 Pro 7B - Function calling specialist
   * - Context: 32K tokens
   * - Function calling: Yes
   * - Best for: Tool use, fast inference with function calling
   */
  static hermes2Pro7b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/nousresearch/hermes-2-pro-mistral-7b");
  }

  // Legacy models - May be deprecated

  /**
   * Gemma 7B
   * @deprecated This model may be deprecated by Cloudflare
   */
  static gemma7b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/google/gemma-7b-it");
  }

  /**
   * Qwen 1.5 14B
   * @deprecated This model may be deprecated by Cloudflare
   */
  static qwen14b(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/qwen/qwen1.5-14b-chat-awq");
  }

  /**
   * Phi-2
   * @deprecated This model may be deprecated by Cloudflare
   */
  static phi2(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/microsoft/phi-2");
  }

  /**
   * DeepSeek Math 7B - Specialized for mathematical reasoning
   * @deprecated This model may be deprecated by Cloudflare
   */
  static deepseekMath(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/deepseek-ai/deepseek-math-7b-instruct");
  }

  /**
   * DeepSeek Coder 6.7B - Specialized for code generation
   * @deprecated This model may be deprecated by Cloudflare
   */
  static deepseekCoder(config: ProviderConfig): CloudflareAGUIAdapter {
    return CloudflareProviders.createAdapter(config, "@cf/thebloke/deepseek-coder-6.7b-instruct-awq");
  }

  /**
   * Automatically select the best model based on requirements
   *
   * Selection criteria:
   * - With tools/function calling: Llama 4 Scout 17B (latest, balanced)
   * - Without tools: Llama 3.1 8B (fast, general purpose)
   *
   * @example
   * ```typescript
   * // Auto-selects Llama 4 Scout because tools are provided
   * const adapter = CloudflareProviders.auto({
   *   accountId: "...",
   *   apiToken: "...",
   *   tools: [weatherTool]
   * });
   * ```
   */
  static auto(config: ProviderConfig): CloudflareAGUIAdapter {
    // Auto-select based on capabilities needed
    const needsFunctionCalling = config.tools && config.tools.length > 0;

    if (needsFunctionCalling) {
      // Llama 4 Scout 17B offers latest features with good balance of speed and capability
      return CloudflareProviders.llama4Scout17b(config);
    }

    // Default to fast 8B model for general use
    return CloudflareProviders.llama3_8b(config);
  }

  /**
   * Create adapter with AI Gateway for caching, analytics, and rate limiting
   *
   * @param accountId - Cloudflare account ID
   * @param apiToken - Cloudflare API token
   * @param gatewayId - AI Gateway ID
   * @param model - Optional model (defaults to Llama 3.1 8B)
   *
   * @example
   * ```typescript
   * const adapter = CloudflareProviders.createWithGateway(
   *   "account-id",
   *   "api-token",
   *   "my-gateway",
   *   "@cf/meta/llama-4-scout-17b-16e-instruct"
   * );
   * ```
   */
  static createWithGateway(
    accountId: string,
    apiToken: string,
    gatewayId: string,
    model?: CloudflareModel,
  ): CloudflareAGUIAdapter {
    return new CloudflareAGUIAdapter({
      accountId,
      apiToken,
      gatewayId,
      model: model || "@cf/meta/llama-3.1-8b-instruct",
    });
  }
}
