## `AgentCapabilities` and its groups, as defined in `spec/1.0/schema.json`.
##
## Every member is optional: an omitted group or flag means "not declared",
## and the codec never fills one in (sdks/fixtures/README.md,
## "agent-capabilities").

import std/[json, options]
import ./types

export types

type
  SubagentInfo* = object
    name*: string
    description*: Option[string]

  IdentityCapabilities* = object
    name*: Option[string]
    `type`*: Option[string]
    description*: Option[string]
    version*: Option[string]
    provider*: Option[string]
    documentationUrl*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]

  TransportCapabilities* = object
    streaming*: Option[bool]
    websocket*: Option[bool]
    httpBinary*: Option[bool]
    pushNotifications*: Option[bool]
    resumable*: Option[bool]

  ToolsCapabilities* = object
    supported*: Option[bool]
    items*: Option[seq[Tool]]
    parallelCalls*: Option[bool]
    clientProvided*: Option[bool]

  OutputCapabilities* = object
    structuredOutput*: Option[bool]
    supportedMimeTypes*: Option[seq[string]]

  StateCapabilities* = object
    snapshots*: Option[bool]
    deltas*: Option[bool]
    memory*: Option[bool]
    persistentState*: Option[bool]

  MultiAgentCapabilities* = object
    supported*: Option[bool]
    delegation*: Option[bool]
    handoffs*: Option[bool]
    subagents*: Option[seq[SubagentInfo]]

  ReasoningCapabilities* = object
    supported*: Option[bool]
    streaming*: Option[bool]
    encrypted*: Option[bool]

  MultimodalInputCapabilities* = object
    image*: Option[bool]
    audio*: Option[bool]
    video*: Option[bool]
    pdf*: Option[bool]
    file*: Option[bool]

  MultimodalOutputCapabilities* = object
    image*: Option[bool]
    audio*: Option[bool]

  MultimodalCapabilities* = object
    input*: Option[MultimodalInputCapabilities]
    output*: Option[MultimodalOutputCapabilities]

  ExecutionCapabilities* = object
    codeExecution*: Option[bool]
    sandboxed*: Option[bool]
    maxIterations* {.nonNegative.}: Option[int64]
    maxExecutionTime* {.nonNegative.}: Option[int64]

  HumanInTheLoopCapabilities* = object
    supported*: Option[bool]
    approvals*: Option[bool]
    interventions*: Option[bool]
    feedback*: Option[bool]
    interrupts*: Option[bool]
    approveWithEdits*: Option[bool]

  AgentCapabilities* = object
    identity*: Option[IdentityCapabilities]
    transport*: Option[TransportCapabilities]
    tools*: Option[ToolsCapabilities]
    output*: Option[OutputCapabilities]
    state*: Option[StateCapabilities]
    multiAgent*: Option[MultiAgentCapabilities]
    reasoning*: Option[ReasoningCapabilities]
    multimodal*: Option[MultimodalCapabilities]
    execution*: Option[ExecutionCapabilities]
    humanInTheLoop*: Option[HumanInTheLoopCapabilities]
    custom* {.jsonObject.}: Option[JsonNode]

objectCodec(SubagentInfo)
objectCodec(IdentityCapabilities)
objectCodec(TransportCapabilities)
objectCodec(ToolsCapabilities)
objectCodec(OutputCapabilities)
objectCodec(StateCapabilities)
objectCodec(MultiAgentCapabilities)
objectCodec(ReasoningCapabilities)
objectCodec(MultimodalInputCapabilities)
objectCodec(MultimodalOutputCapabilities)
objectCodec(MultimodalCapabilities)
objectCodec(ExecutionCapabilities)
objectCodec(HumanInTheLoopCapabilities)
objectCodec(AgentCapabilities)
