import { CloudflareAGUIAdapter, CloudflareAGUIAdapterOptions } from "./adapter";
import { CloudflareModel } from "./types";

export interface ProviderConfig extends Omit<CloudflareAGUIAdapterOptions, "model"> {
  model?: CloudflareModel;
}

export class CloudflareProviders {
  static llama3_8b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/meta/llama-3.1-8b-instruct",
    });
  }

  static llama3_70b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/meta/llama-3.1-70b-instruct",
    });
  }

  static llama3_3_70b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/meta/llama-3.3-70b-instruct",
    });
  }

  static mistral7b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/mistral/mistral-7b-instruct-v0.2",
    });
  }

  static gemma7b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/google/gemma-7b-it",
    });
  }

  static qwen14b(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/qwen/qwen1.5-14b-chat-awq",
    });
  }

  static phi2(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/microsoft/phi-2",
    });
  }

  static deepseekMath(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/deepseek-ai/deepseek-math-7b-instruct",
    });
  }

  static deepseekCoder(config: ProviderConfig) {
    return new CloudflareAGUIAdapter({
      ...config,
      model: config.model || "@cf/thebloke/deepseek-coder-6.7b-instruct-awq",
    });
  }

  static auto(config: ProviderConfig) {
    // Auto-select based on capabilities needed
    const needsFunctionCalling = config.tools && config.tools.length > 0;

    if (needsFunctionCalling) {
      // Only Llama 3.3 70B supports function calling
      return CloudflareProviders.llama3_3_70b(config);
    }

    // Default to fast 8B model for general use
    return CloudflareProviders.llama3_8b(config);
  }

  static createWithGateway(
    accountId: string,
    apiToken: string,
    gatewayId: string,
    model?: CloudflareModel,
  ) {
    return new CloudflareAGUIAdapter({
      accountId,
      apiToken,
      gatewayId,
      model: model || "@cf/meta/llama-3.1-8b-instruct",
    });
  }
}
