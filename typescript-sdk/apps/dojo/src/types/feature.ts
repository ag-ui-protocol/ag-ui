export interface ViewerConfig {
  showCodeEditor?: boolean;
  showFileTree?: boolean;
  showLLMSelector?: boolean;
}

export interface FeatureFile {
  name: string;
  content: string;
  // path: string;
  language: string;
  type: string;
}

export interface FeatureConfig {
  id: string;
  name: string;
  description: string;
  path: string;
  tags?: string[];
}
