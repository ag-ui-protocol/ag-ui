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

    context "Role" do
      should "include reasoning in Role values" do
        assert_includes AgUiProtocol::Core::Types::Role, "reasoning"
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

      should "support encrypted_value" do
        obj = AgUiProtocol::Core::Types::ToolCall.new(id: "tc1", function: { name: "f", arguments: "{}" }, encrypted_value: "enc")
        payload = JSON.parse(obj.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "omit encrypted_value when nil" do
        obj = AgUiProtocol::Core::Types::ToolCall.new(id: "tc1", function: { name: "f", arguments: "{}" })
        payload = JSON.parse(obj.to_json)
        refute payload.key?("encryptedValue")
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

      should "support encrypted_value" do
        obj = AgUiProtocol::Core::Types::BaseMessage.new(id: "m1", role: "assistant", content: "hi", encrypted_value: "enc")
        payload = JSON.parse(obj.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "omit encrypted_value when nil" do
        obj = AgUiProtocol::Core::Types::BaseMessage.new(id: "m1", role: "assistant", content: "hi")
        payload = JSON.parse(obj.to_json)
        refute payload.key?("encryptedValue")
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

      should "support encrypted_value" do
        obj = AgUiProtocol::Core::Types::AssistantMessage.new(id: "a1", content: "hi", encrypted_value: "enc")
        payload = JSON.parse(obj.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "omit encrypted_value when nil" do
        obj = AgUiProtocol::Core::Types::AssistantMessage.new(id: "a1", content: "hi")
        payload = JSON.parse(obj.to_json)
        refute payload.key?("encryptedValue")
      end

      should "accept tool_calls hash with string keys" do
        obj = AgUiProtocol::Core::Types::AssistantMessage.new(
          id: "a1",
          content: "hi",
          tool_calls: [{ "id" => "tc1", "function" => { "name" => "f", "arguments" => "{}" } }]
        )
        assert_kind_of AgUiProtocol::Core::Types::ToolCall, obj.tool_calls[0]
        assert_equal "tc1", obj.tool_calls[0].id
        assert_equal "f", obj.tool_calls[0].function.name
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

      should "raise when all source fields are empty strings" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::BinaryInputContent.new(mime_type: "image/png", url: "", data: "", id: "")
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

      should "support encrypted_value" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(id: "u1", content: "hello", encrypted_value: "enc")
        payload = JSON.parse(msg.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "omit encrypted_value when nil" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(id: "u1", content: "hello")
        payload = JSON.parse(msg.to_json)
        refute payload.key?("encryptedValue")
      end

      should "raise on unknown content type in array" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::UserMessage.new(
            id: "u1",
            content: [{ type: "mystery", value: "nope" }]
          )
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

      should "normalize multimodal content types" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", source: { type: "url", value: "https://example.com/a.png", mime_type: "image/png" } },
            { type: "audio", source: { type: "url", value: "https://example.com/a.mp3", mime_type: "audio/mp3" } },
            { type: "video", source: { type: "url", value: "https://example.com/a.mp4", mime_type: "video/mp4" } },
            { type: "document", source: { type: "url", value: "https://example.com/a.pdf", mime_type: "application/pdf" } }
          ]
        )

        assert_kind_of AgUiProtocol::Core::Types::ImageInputContent, msg.content[1]
        assert_kind_of AgUiProtocol::Core::Types::AudioInputContent, msg.content[2]
        assert_kind_of AgUiProtocol::Core::Types::VideoInputContent, msg.content[3]
        assert_kind_of AgUiProtocol::Core::Types::DocumentInputContent, msg.content[4]
      end

      should "accept camelCase mimeType in multimodal image source" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "image", source: { type: "url", value: "https://example.com/a.png", mimeType: "image/png" } }
          ]
        )

        assert_kind_of AgUiProtocol::Core::Types::ImageInputContent, msg.content[0]
        assert_kind_of AgUiProtocol::Core::Types::InputContentUrlSource, msg.content[0].source
        assert_equal "image/png", msg.content[0].source.mime_type
      end

      should "accept camelCase fileName in binary content normalization" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "binary", mimeType: "image/png", url: "https://example.com/a.png", fileName: "x.png" }
          ]
        )

        assert_kind_of AgUiProtocol::Core::Types::BinaryInputContent, msg.content[0]
        assert_equal "x.png", msg.content[0].filename
        assert_equal "image/png", msg.content[0].mime_type
        assert_equal "https://example.com/a.png", msg.content[0].url
      end

      should "normalize multimodal content with data source" do
        msg = AgUiProtocol::Core::Types::UserMessage.new(
          id: "u1",
          content: [
            { type: "image", source: { type: "data", value: "base64data", mime_type: "image/png" } }
          ]
        )

        assert_kind_of AgUiProtocol::Core::Types::ImageInputContent, msg.content[0]
        assert_kind_of AgUiProtocol::Core::Types::InputContentDataSource, msg.content[0].source
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

      should "support encrypted_value" do
        msg = AgUiProtocol::Core::Types::ToolMessage.new(id: "tm1", content: "ok", tool_call_id: "tc1", encrypted_value: "enc")
        payload = JSON.parse(msg.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "omit encrypted_value when nil" do
        msg = AgUiProtocol::Core::Types::ToolMessage.new(id: "tm1", content: "ok", tool_call_id: "tc1")
        payload = JSON.parse(msg.to_json)
        refute payload.key?("encryptedValue")
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

      should "serialize structured content payload" do
        msg = AgUiProtocol::Core::Types::ActivityMessage.new(id: "am1", activity_type: "progress", content: { "pct" => 10 })
        payload = JSON.parse(msg.to_json)
        assert_equal "progress", payload["activityType"]
        assert_equal 10, payload["content"]["pct"]
      end

      should "preserve user-supplied keys verbatim in content" do
        msg = AgUiProtocol::Core::Types::ActivityMessage.new(
          id: "am1",
          activity_type: "progress",
          content: { "step_name" => "indexing", "items_done" => 7 }
        )
        payload = JSON.parse(msg.to_json)
        # `content` is arbitrary user-defined activity payload; keys preserved verbatim.
        assert_equal "indexing", payload["content"]["step_name"]
        assert_equal 7, payload["content"]["items_done"]
        refute payload["content"].key?("stepName")
        refute payload["content"].key?("itemsDone")
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

      should "preserve user-supplied JSON Schema keys verbatim in parameters" do
        # JSON Schema fields like `properties` contain user-named keys that MUST
        # NOT be camelized on the wire.
        obj = AgUiProtocol::Core::Types::Tool.new(
          name: "search",
          description: "Web search",
          parameters: {
            "type" => "object",
            "properties" => {
              "search_query" => { "type" => "string" },
              "max_results" => { "type" => "integer" }
            },
            "required" => ["search_query"]
          }
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "object", payload["parameters"]["type"]
        # Inner schema keys are preserved exactly.
        assert payload["parameters"]["properties"].key?("search_query")
        assert payload["parameters"]["properties"].key?("max_results")
        refute payload["parameters"]["properties"].key?("searchQuery")
        assert_equal "string", payload["parameters"]["properties"]["search_query"]["type"]
        assert_equal ["search_query"], payload["parameters"]["required"]
      end
    end

    context "Interrupt" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::Interrupt.new(id: "int1", reason: "input_required")
        payload = JSON.parse(obj.to_json)
        assert_equal "int1", payload["id"]
        assert_equal "input_required", payload["reason"]
      end

      should "raise when id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::Interrupt.new(reason: "input_required")
        end
      end

      should "preserve user-supplied keys verbatim in response_schema and metadata" do
        obj = AgUiProtocol::Core::Types::Interrupt.new(
          id: "int1",
          reason: "input_required",
          response_schema: {
            "type" => "object",
            "properties" => {
              "user_answer" => { "type" => "string" }
            }
          },
          metadata: { "trace_id" => "abc", "client_flag" => true }
        )
        payload = JSON.parse(obj.to_json)
        # response_schema is JSON Schema; inner keys must be preserved.
        assert payload["responseSchema"]["properties"].key?("user_answer")
        refute payload["responseSchema"]["properties"].key?("userAnswer")
        # metadata is arbitrary user data; inner keys must be preserved.
        assert_equal "abc", payload["metadata"]["trace_id"]
        assert_equal true, payload["metadata"]["client_flag"]
        refute payload["metadata"].key?("traceId")
      end

      should "include optional fields in to_h" do
        obj = AgUiProtocol::Core::Types::Interrupt.new(
          id: "int1", reason: "input_required",
          message: "Please provide input", tool_call_id: "tc1",
          response_schema: { "type" => "object" }, expires_at: "2026-01-01T00:00:00Z",
          metadata: { "key" => "val" }
        )
        hash = obj.to_h
        assert_equal "Please provide input", hash[:message]
        assert_equal "tc1", hash[:tool_call_id]
        assert_equal "2026-01-01T00:00:00Z", hash[:expires_at]
        # response_schema and metadata are user-supplied opaque payloads; to_h
        # wraps them in Util::Opaque so the serializer preserves their keys
        # verbatim (no camelCase rewriting, no nil compaction).
        assert_kind_of AgUiProtocol::Util::Opaque, hash[:response_schema]
        assert_equal({ "type" => "object" }, hash[:response_schema].value)
        assert_kind_of AgUiProtocol::Util::Opaque, hash[:metadata]
        assert_equal({ "key" => "val" }, hash[:metadata].value)
      end
    end

    context "ResumeEntry" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::ResumeEntry.new(interrupt_id: "int1", status: "resolved", payload: { "ok" => true })
        payload = JSON.parse(obj.to_json)
        assert_equal "int1", payload["interruptId"]
        assert_equal "resolved", payload["status"]
      end

      should "raise when interrupt_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::ResumeEntry.new(status: "resolved", payload: {})
        end
      end

      should "allow omitting status and payload" do
        obj = AgUiProtocol::Core::Types::ResumeEntry.new(interrupt_id: "int1")
        payload = JSON.parse(obj.to_json)
        assert_equal "int1", payload["interruptId"]
        refute payload.key?("status")
        refute payload.key?("payload")
      end

      should "preserve user-supplied keys verbatim in payload" do
        obj = AgUiProtocol::Core::Types::ResumeEntry.new(
          interrupt_id: "int1",
          status: "resolved",
          payload: { "user_answer" => "42", "extra_info" => { "deep_key" => true } }
        )
        wire = JSON.parse(obj.to_json)
        assert_equal "42", wire["payload"]["user_answer"]
        assert_equal true, wire["payload"]["extra_info"]["deep_key"]
        refute wire["payload"].key?("userAnswer")
        refute wire["payload"].key?("extraInfo")
      end
    end

    context "InputContentDataSource" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::InputContentDataSource.new(value: "base64data", mime_type: "image/png")
        payload = JSON.parse(obj.to_json)
        assert_equal "data", payload["type"]
        assert_equal "base64data", payload["value"]
        assert_equal "image/png", payload["mimeType"]
      end
    end

    context "InputContentUrlSource" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::InputContentUrlSource.new(value: "https://example.com/a.png", mime_type: "image/png")
        payload = JSON.parse(obj.to_json)
        assert_equal "url", payload["type"]
        assert_equal "https://example.com/a.png", payload["value"]
        assert_equal "image/png", payload["mimeType"]
      end
    end

    context "ImageInputContent" do
      should "serialize to JSON" do
        source = AgUiProtocol::Core::Types::InputContentUrlSource.new(value: "https://example.com/a.png", mime_type: "image/png")
        obj = AgUiProtocol::Core::Types::ImageInputContent.new(source: source)
        payload = JSON.parse(obj.to_json)
        assert_equal "image", payload["type"]
        assert_equal "url", payload["source"]["type"]
      end

      should "accept hash source" do
        obj = AgUiProtocol::Core::Types::ImageInputContent.new(source: { type: "url", value: "https://example.com/a.png", mime_type: "image/png" })
        assert_kind_of AgUiProtocol::Core::Types::InputContentUrlSource, obj.source
      end
    end

    context "AudioInputContent" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::AudioInputContent.new(source: { type: "url", value: "https://example.com/a.mp3", mime_type: "audio/mp3" })
        payload = JSON.parse(obj.to_json)
        assert_equal "audio", payload["type"]
        assert_equal "url", payload["source"]["type"]
      end
    end

    context "VideoInputContent" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::VideoInputContent.new(source: { type: "url", value: "https://example.com/a.mp4", mime_type: "video/mp4" })
        payload = JSON.parse(obj.to_json)
        assert_equal "video", payload["type"]
        assert_equal "url", payload["source"]["type"]
      end
    end

    context "DocumentInputContent" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::DocumentInputContent.new(source: { type: "url", value: "https://example.com/a.pdf", mime_type: "application/pdf" })
        payload = JSON.parse(obj.to_json)
        assert_equal "document", payload["type"]
        assert_equal "url", payload["source"]["type"]
      end
    end

    context "ReasoningMessage" do
      should "serialize to JSON" do
        obj = AgUiProtocol::Core::Types::ReasoningMessage.new(id: "r1", content: "step 1")
        payload = JSON.parse(obj.to_json)
        assert_equal "reasoning", payload["role"]
        assert_equal "step 1", payload["content"]
      end

      should "support encrypted_value" do
        obj = AgUiProtocol::Core::Types::ReasoningMessage.new(id: "r1", content: "step 1", encrypted_value: "enc")
        payload = JSON.parse(obj.to_json)
        assert_equal "enc", payload["encryptedValue"]
      end

      should "raise when id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::ReasoningMessage.new(content: "step 1")
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

      should "support resume field" do
        resume = [
          AgUiProtocol::Core::Types::ResumeEntry.new(interrupt_id: "int1", status: "resolved", payload: {})
        ]
        obj = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1", run_id: "r1", state: {},
          messages: [], tools: [], context: [], forwarded_props: {},
          resume: resume
        )
        payload = JSON.parse(obj.to_json)
        assert_equal "int1", payload["resume"][0]["interruptId"]
      end

      should "omit resume when nil" do
        obj = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1", run_id: "r1", state: {},
          messages: [], tools: [], context: [], forwarded_props: {}
        )
        payload = JSON.parse(obj.to_json)
        refute payload.key?("resume")
      end

      should "raise when resume contains a non-ResumeEntry element" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Types::RunAgentInput.new(
            thread_id: "t1", run_id: "r1", state: {},
            messages: [], tools: [], context: [], forwarded_props: {},
            resume: [{ interrupt_id: "int1", status: "resolved", payload: {} }]
          )
        end
      end

      should "preserve user-supplied keys verbatim in state and forwarded_props" do
        obj = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1",
          run_id: "r1",
          state: { "user_state_key" => { "deep_key" => 1 } },
          messages: [],
          tools: [],
          context: [],
          forwarded_props: { "client_token" => "abc", "feature_flag" => true }
        )
        payload = JSON.parse(obj.to_json)
        # state and forwardedProps are opaque user payloads — keys preserved verbatim.
        assert_equal 1, payload["state"]["user_state_key"]["deep_key"]
        refute payload["state"].key?("userStateKey")
        assert_equal "abc", payload["forwardedProps"]["client_token"]
        assert_equal true, payload["forwardedProps"]["feature_flag"]
        refute payload["forwardedProps"].key?("clientToken")
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
        AgUiProtocol::Core::Types::RunAgentInput.new(
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
