export interface FeatureConfig {
  id: string;
  name: string;
  description: string;
  path: string;
  tags?: string[];
}

export interface ViewerConfig {
  showCodeEditor?: boolean;
  showFileTree?: boolean;
  showLLMSelector?: boolean;
}
