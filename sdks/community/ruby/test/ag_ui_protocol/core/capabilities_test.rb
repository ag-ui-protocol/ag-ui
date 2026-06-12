require "test_helper"
require "json"

class CapabilitiesTest < Minitest::Test
  context "AgUiProtocol::Core::Capabilities" do
    context "SubAgentInfo" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::SubAgentInfo.new(
          name: "search-agent",
          description: "Handles web search"
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "search-agent", payload["name"]
        assert_equal "Handles web search", payload["description"]
      end

      should "omit nil description" do
        obj = AgUiProtocol::Core::Capabilities::SubAgentInfo.new(name: "search-agent")
        payload = JSON.parse(obj.to_json)
        assert_equal "search-agent", payload["name"]
        refute payload.key?("description")
      end
    end

    context "IdentityCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::IdentityCapabilities.new(
          name: "MyAgent",
          type: "langgraph",
          description: "A helpful agent",
          version: "1.0.0",
          provider: "ACME Corp",
          documentation_url: "https://example.com/docs",
          metadata: { "key" => "val" }
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "MyAgent", payload["name"]
        assert_equal "langgraph", payload["type"]
        assert_equal "A helpful agent", payload["description"]
        assert_equal "1.0.0", payload["version"]
        assert_equal "ACME Corp", payload["provider"]
        assert_equal "https://example.com/docs", payload["documentationUrl"]
        assert_equal "val", payload["metadata"]["key"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::IdentityCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end

      should "preserve user-supplied metadata keys verbatim (no camelCase rewriting)" do
        obj = AgUiProtocol::Core::Capabilities::IdentityCapabilities.new(
          metadata: { "agent_id" => "x", "feature_flag" => true, "nested_thing" => { "user_key" => "raw" } }
        )
        payload = JSON.parse(obj.to_json)
        # metadata is an opaque user-defined Hash; inner keys must NOT be camelized.
        assert_equal "x", payload["metadata"]["agent_id"]
        assert_equal true, payload["metadata"]["feature_flag"]
        assert_equal "raw", payload["metadata"]["nested_thing"]["user_key"]
      end
    end

    context "TransportCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::TransportCapabilities.new(
          streaming: true, websocket: false
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["streaming"]
        assert_equal false, payload["websocket"]
      end

      should "include only set fields" do
        obj = AgUiProtocol::Core::Capabilities::TransportCapabilities.new(
          streaming: true
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["streaming"]
        refute payload.key?("websocket")
        refute payload.key?("httpBinary")
        refute payload.key?("pushNotifications")
        refute payload.key?("resumable")
      end
    end

    context "ToolsCapabilities" do
      should "serialize to JSON with camelCase" do
        tool = AgUiProtocol::Core::Types::Tool.new(
          name: "search", description: "Web search",
          parameters: { type: "object", properties: {} }
        )
        obj = AgUiProtocol::Core::Capabilities::ToolsCapabilities.new(
          supported: true, items: [tool], parallel_calls: true, client_provided: false
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["supported"]
        assert_equal "search", payload["items"][0]["name"]
        assert_equal true, payload["parallelCalls"]
        assert_equal false, payload["clientProvided"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::ToolsCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "OutputCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::OutputCapabilities.new(
          structured_output: true,
          supported_mime_types: ["text/plain", "application/json"]
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["structuredOutput"]
        assert_equal ["text/plain", "application/json"], payload["supportedMimeTypes"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::OutputCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "StateCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::StateCapabilities.new(
          snapshots: true, deltas: false, memory: true, persistent_state: true
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["snapshots"]
        assert_equal false, payload["deltas"]
        assert_equal true, payload["memory"]
        assert_equal true, payload["persistentState"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::StateCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "MultiAgentCapabilities" do
      should "serialize to JSON with camelCase" do
        sub = AgUiProtocol::Core::Capabilities::SubAgentInfo.new(
          name: "research", description: "Research agent"
        )
        obj = AgUiProtocol::Core::Capabilities::MultiAgentCapabilities.new(
          supported: true, delegation: true, handoffs: false, sub_agents: [sub]
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["supported"]
        assert_equal true, payload["delegation"]
        assert_equal false, payload["handoffs"]
        assert_equal "research", payload["subAgents"][0]["name"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::MultiAgentCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "ReasoningCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::ReasoningCapabilities.new(
          supported: true, streaming: true, encrypted: false
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["supported"]
        assert_equal true, payload["streaming"]
        assert_equal false, payload["encrypted"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::ReasoningCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "MultimodalInputCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::MultimodalInputCapabilities.new(
          image: true, audio: false, video: true
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["image"]
        assert_equal false, payload["audio"]
        assert_equal true, payload["video"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::MultimodalInputCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "MultimodalOutputCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::MultimodalOutputCapabilities.new(
          image: true, audio: true
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["image"]
        assert_equal true, payload["audio"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::MultimodalOutputCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "MultimodalCapabilities" do
      should "serialize to JSON with camelCase" do
        input = AgUiProtocol::Core::Capabilities::MultimodalInputCapabilities.new(
          image: true, audio: true
        )
        output = AgUiProtocol::Core::Capabilities::MultimodalOutputCapabilities.new(
          image: false
        )
        obj = AgUiProtocol::Core::Capabilities::MultimodalCapabilities.new(
          input: input, output: output
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["input"]["image"]
        assert_equal true, payload["input"]["audio"]
        assert_equal false, payload["output"]["image"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::MultimodalCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "ExecutionCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::ExecutionCapabilities.new(
          code_execution: true, sandboxed: true,
          max_iterations: 10, max_execution_time: 30000
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["codeExecution"]
        assert_equal true, payload["sandboxed"]
        assert_equal 10, payload["maxIterations"]
        assert_equal 30000, payload["maxExecutionTime"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::ExecutionCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "HumanInTheLoopCapabilities" do
      should "serialize to JSON with camelCase" do
        obj = AgUiProtocol::Core::Capabilities::HumanInTheLoopCapabilities.new(
          supported: true, approvals: true, interventions: false,
          feedback: true, interrupts: false, approve_with_edits: true
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["supported"]
        assert_equal true, payload["approvals"]
        assert_equal false, payload["interventions"]
        assert_equal true, payload["feedback"]
        assert_equal false, payload["interrupts"]
        assert_equal true, payload["approveWithEdits"]
      end

      should "omit nil fields" do
        obj = AgUiProtocol::Core::Capabilities::HumanInTheLoopCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end
    end

    context "AgentCapabilities" do
      should "serialize empty to JSON" do
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new
        payload = JSON.parse(obj.to_json)
        assert_equal({}, payload)
      end

      should "include sub-capabilities" do
        identity = AgUiProtocol::Core::Capabilities::IdentityCapabilities.new(
          name: "Agent", version: "1"
        )
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new(identity: identity)
        payload = JSON.parse(obj.to_json)
        assert_equal "Agent", payload["identity"]["name"]
      end

      should "include nested capabilities" do
        transport = AgUiProtocol::Core::Capabilities::TransportCapabilities.new(
          streaming: true
        )
        reasoning = AgUiProtocol::Core::Capabilities::ReasoningCapabilities.new(
          supported: true
        )
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new(
          transport: transport, reasoning: reasoning
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["transport"]["streaming"]
        assert_equal true, payload["reasoning"]["supported"]
      end

      should "serialize custom field" do
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new(
          custom: { "featureX" => { "enabled" => true } }
        )
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["custom"]["featureX"]["enabled"]
      end

      should "preserve user-supplied custom keys verbatim (no camelCase rewriting)" do
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new(
          custom: { "agent_id" => "x", "feature_flag" => { "deep_key" => 1 } }
        )
        payload = JSON.parse(obj.to_json)
        # `custom` is the explicit escape hatch; inner keys must NOT be camelized.
        assert_equal "x", payload["custom"]["agent_id"]
        assert_equal 1, payload["custom"]["feature_flag"]["deep_key"]
      end

      should "include output capabilities" do
        output = AgUiProtocol::Core::Capabilities::OutputCapabilities.new(
          structured_output: true
        )
        obj = AgUiProtocol::Core::Capabilities::AgentCapabilities.new(output: output)
        payload = JSON.parse(obj.to_json)
        assert_equal true, payload["output"]["structuredOutput"]
      end
    end
  end
end
