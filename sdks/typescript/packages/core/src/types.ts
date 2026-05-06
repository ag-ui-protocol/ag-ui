export type {
  ToolCall,
  FunctionCall,
  TextInputContent,
  InputContentDataSource,
  InputContentUrlSource,
  InputContentSource,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  ImageInputPart,
  AudioInputPart,
  VideoInputPart,
  DocumentInputPart,
  BinaryInputContent,
  InputContent,
  InputContentPart,
  DeveloperMessage,
  SystemMessage,
  AssistantMessage,
  UserMessage,
  ToolMessage,
  ActivityMessage,
  ReasoningMessage,
  Message,
  Role,
  Context,
  Tool,
  Interrupt,
  ResumeEntry,
  ResumeStatus,
  RunAgentInput,
  State,
} from "./types-static";

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AGUIConnectNotImplementedError extends AGUIError {
  constructor() {
    super("Connect not implemented. This method is not supported by the current agent.");
  }
}
