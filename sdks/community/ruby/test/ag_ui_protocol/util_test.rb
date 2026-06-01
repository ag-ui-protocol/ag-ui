require "test_helper"
require "json"

class UtilTest < Minitest::Test
  context "AgUiProtocol::Util::Opaque" do
    should "expose its wrapped value via #value" do
      wrapped = AgUiProtocol::Util::Opaque.new({ "agent_id" => "x" })
      assert_equal({ "agent_id" => "x" }, wrapped.value)
    end
  end

  context "AgUiProtocol::Util.deep_compact" do
    should "leave Opaque wrappers untouched (no recursion, no nil pruning)" do
      payload = { "agent_id" => "x", "feature_flag" => nil, "nested" => { "user_key" => nil } }
      result = AgUiProtocol::Util.deep_compact(AgUiProtocol::Util::Opaque.new(payload))
      assert_kind_of AgUiProtocol::Util::Opaque, result
      # Inner Hash is the same identity-preserved Hash; nils are NOT stripped.
      assert_equal payload, result.value
      assert_nil result.value["feature_flag"]
      assert_nil result.value["nested"]["user_key"]
    end

    should "not recurse into Opaque-wrapped values inside a Hash" do
      input = {
        keep_me: nil,
        opaque_field: AgUiProtocol::Util::Opaque.new({ "user_key" => nil, "other" => 1 })
      }
      result = AgUiProtocol::Util.deep_compact(input)
      refute result.key?(:keep_me) # outer nils are still pruned
      assert_kind_of AgUiProtocol::Util::Opaque, result[:opaque_field]
      assert_equal({ "user_key" => nil, "other" => 1 }, result[:opaque_field].value)
    end
  end

  context "AgUiProtocol::Util.deep_transform_keys_to_camel" do
    should "unwrap Opaque and return inner value verbatim (no key camelization)" do
      wrapped = AgUiProtocol::Util::Opaque.new({ "agent_id" => "x", "feature_flag" => true })
      result = AgUiProtocol::Util.deep_transform_keys_to_camel(wrapped)
      assert_equal({ "agent_id" => "x", "feature_flag" => true }, result)
    end

    should "preserve Opaque-wrapped values inside an enclosing Hash while camelizing the outer keys" do
      input = {
        outer_key: "v",
        opaque_field: AgUiProtocol::Util::Opaque.new({ "nested_key" => { "deep_key" => 1 } })
      }
      result = AgUiProtocol::Util.deep_transform_keys_to_camel(input)
      assert_equal "v", result["outerKey"]
      # opaque inner Hash keys remain snake_case.
      assert_equal({ "nested_key" => { "deep_key" => 1 } }, result["opaqueField"])
    end

    should "preserve Opaque values inside an Array" do
      arr = [
        { "outer_one" => 1 },
        AgUiProtocol::Util::Opaque.new({ "user_key" => "raw" })
      ]
      result = AgUiProtocol::Util.deep_transform_keys_to_camel(arr)
      # Element 0 is a normal Hash — keys ARE camelized (snake_case → camelCase).
      assert_equal({ "outerOne" => 1 }, result[0])
      # Element 1 is Opaque — keys preserved verbatim.
      assert_equal({ "user_key" => "raw" }, result[1])
    end
  end

  context "AgUiProtocol::Util.normalize_value (Time)" do
    should "convert Time to epoch milliseconds (Integer)" do
      t = Time.utc(2026, 5, 26, 12, 0, 0)
      result = AgUiProtocol::Util.normalize_value(t)
      assert_kind_of Integer, result
      # 2026-05-26T12:00:00Z == 1779796800 seconds since epoch == 1779796800000 ms
      assert_equal 1779796800000, result
    end

    should "preserve sub-second precision when converting Time to epoch milliseconds" do
      t = Time.utc(2026, 5, 26, 12, 0, 0, 500_000)
      assert_equal 1779796800500, AgUiProtocol::Util.normalize_value(t)
    end
  end
end
