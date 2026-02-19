require "test_helper"
require "json"

class TypesTest < Minitest::Test
  context "AgUiProtocol::Core::Types" do
    context "Model" do
      should "don't serialize to JSON because it's abstract" do
        assert_raises(NotImplementedError) do
          AgUiProtocol::Core::Types::Model.new.to_json
        end
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::Model.new(unknown: 1)
        end
      end
    end

    context "FunctionCall" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::FunctionCall.new(name: "f", arguments: "{}")
        payload = JSON.parse(obj.to_json)
        assert_equal "f", payload["name"]
      end

      should "raise when name is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::FunctionCall.new(arguments: "{}")
        end
      end
    end

    context "ToolCall" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::ToolCall.new(id: "tc1", function: { name: "f", arguments: "{}" })
        payload = JSON.parse(obj.to_json)
        assert_equal "tc1", payload["id"]
        assert_equal "function", payload["type"]
      end

      should "raise when function is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::ToolCall.new(id: "tc1")
        end
      end
    end

    context "BaseMessage" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::BaseMessage.new(id: "m1", role: "assistant", content: "hi")
        payload = JSON.parse(obj.to_json)
        assert_equal "assistant", payload["role"]
      end

      should "raise when role is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::BaseMessage.new(id: "m1")
        end
      end
    end

    context "DeveloperMessage" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::DeveloperMessage.new(id: "d1", content: "hi")
        payload = JSON.parse(obj.to_json)
        assert_equal "developer", payload["role"]
      end

      should "raise when content is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::DeveloperMessage.new(id: "d1")
        end
      end
    end

    context "SystemMessage" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::SystemMessage.new(id: "s1", content: "hi")
        payload = JSON.parse(obj.to_json)
        assert_equal "system", payload["role"]
      end

      should "raise when content is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::SystemMessage.new(id: "s1")
        end
      end
    end

    context "AssistantMessage" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::AssistantMessage.new(
          id: "a1",
          content: "hi",
          tool_calls: [{ id: "tc1", function: { name: "f", arguments: "{}" } }]
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "assistant", payload["role"]
      end

      should "raise when tool_calls are invalid" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::AssistantMessage.new(id: "a1", tool_calls: [{ id: "tc1" }])
        end
      end
    end

    context "TextInputContent" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::TextInputContent.new(text: "hello")
        payload = JSON.parse(obj.to_json)
        assert_equal "text", payload["type"]
      end

      should "raise when text is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::TextInputContent.new
        end
      end
    end

    context "BinaryInputContent" do
      should "raise when no source is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::BinaryInputContent.new(mime_type: "image/png")
        end
      end

      should "serialize with camelCase" do
        content = AgUiProtocol::Core::Types::BinaryInputContent.new(mime_type: "image/png", url: "https://example.com/a.png")
        payload = JSON.parse(content.to_json)

        assert_equal "binary", payload["type"]
        assert_equal "image/png", payload["mimeType"]
        assert_equal "https://example.com/a.png", payload["url"]
        refute payload.key?("data")
      end

      should "raise when mime_type is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::BinaryInputContent.new(url: "https://example.com/a.png")
        end
      end
    end

    context "UserMessage" do
      should "serialize to JSON" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(id: "u1", content: "hello")
        payload = JSON.parse(msg.to_json)
        assert_equal "user", payload["role"]
      end

      should "raise when id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::UserMessage.new(content: "hello")
        end
      end

      should "normalize array content into typed input content models" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "text", text: "hello" },
            { type: "binary", mimeType: "image/png", url: "https://example.com/a.png" }
          ]
        )

        assert_kind_of Array, msg.content
        assert_kind_of AgUiProtocol::Core::Types::TextInputContent, msg.content[0]
        assert_kind_of AgUiProtocol::Core::Types::BinaryInputContent, msg.content[1]
      end

      should "serialize content with camelCase keys" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "binary", mimeType: "image/png", url: "https://example.com/a.png", filename: nil }
          ]
        )

        payload = JSON.parse(msg.to_json)

        assert_equal "u1", payload["id"]
        assert_equal "user", payload["role"]
        assert_kind_of Array, payload["content"]
        assert_equal "binary", payload["content"][0]["type"]
        assert_equal "image/png", payload["content"][0]["mimeType"]
        assert_equal "https://example.com/a.png", payload["content"][0]["url"]
        refute payload["content"][0].key?("filename")
      end
    end

    context "ToolMessage" do
      should "serialize to JSON" do
        msg = AgUiProtocol::Core::Types::ToolMessage.new(id: "tm1", content: "ok", tool_call_id: "tc1")
        payload = JSON.parse(msg.to_json)
        assert_equal "tool", payload["role"]
      end

      should "raise when tool_call_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::ToolMessage.new(id: "tm1", content: "ok")
        end
      end
    end

    context "ActivityMessage" do
      should "serialize to JSON" do
        msg = AgUiProtocol::Core::Types::ActivityMessage.new(id: "am1", activity_type: "progress", content: { "pct" => 10 })
        payload = JSON.parse(msg.to_json)
        assert_equal "activity", payload["role"]
      end

      should "raise when activity_type is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::ActivityMessage.new(id: "am1", content: { "pct" => 10 })
        end
      end
    end

    context "Context" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::Context.new(description: "d", value: "v")
        payload = JSON.parse(obj.to_json)
        assert_equal "d", payload["description"]
      end

      should "raise when value is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::Context.new(description: "d")
        end
      end
    end

    context "Tool" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::Tool.new(name: "t", description: "d", parameters: { "type" => "object" })
        payload = JSON.parse(obj.to_json)
        assert_equal "t", payload["name"]
      end

      should "raise when parameters is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::Tool.new(name: "t", description: "d")
        end
      end
    end

    context "RunAgentInput" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1",
          run_id: "r1",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwarded_props: {}
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "t1", payload["threadId"]
      end

      should "raise when forwarded_props is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::RunAgentInput.new(thread_id: "t1", run_id: "r1", state: {}, messages: [], tools: [], context: [])
        end
      end
    end

    should "work with array content" do
      messages = [
        AgUiProtocol::Core::Types::UserMessage.new(id: "u1", content: "hello"),
        AgUiProtocol::Core::Types::AssistantMessage.new(id: "a1", content: "hi"),
        AgUiProtocol::Core::Types::ActivityMessage.new(id: "am1", activity_type: "progress", content: { "pct" => 10 }),
      ]
      tools = [
        AgUiProtocol::Core::Types::Tool.new(name: "t1", description: "d1", parameters: { "type" => "object" }),
      ]
      context = [
        AgUiProtocol::Core::Types::Context.new(description: "d1", value: "v1"),
      ]
      obj = AgUiProtocol::Core::Types::RunAgentInput.new(
        thread_id: "t1",
        run_id: "r1",
        state: {},
        messages: messages,
        tools: tools,
        context: context,
        forwarded_props: {}
      )
      payload = JSON.parse(obj.to_json)
      assert_equal "t1", payload["threadId"]
      assert_equal "r1", payload["runId"]
      assert_equal "u1", payload["messages"][0]["id"]
      assert_equal "a1", payload["messages"][1]["id"]
      assert_equal "am1", payload["messages"][2]["id"]
    end

    should "raise when messages type is invalid" do
      messages = [
        AgUiProtocol::Core::Types::TextInputContent.new(text: "hello"),
        AgUiProtocol::Core::Types::FunctionCall.new(name: "f", arguments: "{}"),
        AgUiProtocol::Core::Types::ToolCall.new(id: "tc1", function: { name: "f", arguments: "{}" }),
      ]
      
      assert_raises(ArgumentError) do
        obj = AgUiProtocol::Core::Types::RunAgentInput.new(
        thread_id: "t1",
        run_id: "r1",
        state: {},
        messages: messages,
        tools: [],
        context: [],
        forwarded_props: {}
      )
      end
    end
  end
end
