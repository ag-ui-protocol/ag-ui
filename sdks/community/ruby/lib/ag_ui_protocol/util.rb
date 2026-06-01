# typed: true
# frozen_string_literal: true

require "sorbet-runtime"
require "json"

module AgUiProtocol
  # Utility methods for encoding events.
  module Util
    extend T::Sig

    # Marks a value as opaque user-supplied payload that MUST pass through
    # serialization unchanged — no key camelization, no nil compaction, no
    # recursive normalization.
    #
    # Use this for fields where the AG-UI protocol carries arbitrary
    # user-defined Hash content (e.g., `metadata`, `custom`, `response_schema`,
    # JSON Patch op payloads, raw upstream events). Schema-typed fields whose
    # keys are part of the protocol contract MUST NOT be wrapped — those still
    # need camelCase rewriting on the wire.
    #
    # The wrapper unwraps to its original `value` at the camelization boundary
    # in {Util.deep_transform_keys_to_camel}. Keys inside the wrapped value
    # (and any nested Hashes/Arrays within it) are preserved verbatim.
    class Opaque
      extend T::Sig

      sig { returns(T.untyped) }
      attr_reader :value

      sig { params(value: T.untyped).void }
      def initialize(value)
        @value = value
      end
    end

    module_function

    # @param value [Object]
    # @return [Object]
    sig { params(value: T.untyped).returns(T.untyped) }
    def normalize_value(value)
      case value
      when Opaque
        # Preserve the wrapper so downstream stages can recognize and skip it.
        value
      when Time
        # AG-UI protocol wire format for BaseEvent.timestamp is epoch
        # milliseconds (matches Python SDK `Optional[int]` and TypeScript
        # `z.number().optional()`).
        (value.to_f * 1000).to_i
      when AgUiProtocol::Core::Types::Model
        value.to_h
      else
        value
      end
    end

    # @param key [Object]
    # @return [String]
    sig { params(key: T.untyped).returns(String) }
    def camelize_key(key)
      str = key.to_s
      parts = str.split("_")
      return str if parts.length <= 1

      parts[0] + parts[1..].map { |p| p.empty? ? "" : (p[0].upcase + p[1..]) }.join
    end

    # @param value [Object]
    # @return [Object]
    sig { params(value: T.untyped).returns(T.untyped) }
    def deep_compact(value)
      value = normalize_value(value)
      case value
      when Opaque
        # Opaque payloads are pass-through: do not recurse into their content
        # and do not strip nils. The wrapper is unwrapped during camelization.
        value
      when Hash
        value.transform_values { |v| deep_compact(v) unless v.nil? }.tap(&:compact!)
      when Array
        tmp1 = value.map { |v| deep_compact(v) }
        tmp1.reject!(&:nil?)
        tmp1
      else
        value
      end
    end

    # @param value [Object]
    # @return [Object]
    sig { params(value: T.untyped).returns(T.untyped) }
    def deep_transform_keys_to_camel(value)
      value = normalize_value(value)
      case value
      when Opaque
        # Unwrap and emit the inner value verbatim — keys (including nested
        # Hash keys and Array elements) are preserved as supplied by the user.
        value.value
      when Hash
        value.each_with_object({}) do |(k, v), acc|
          acc[camelize_key(k)] = deep_transform_keys_to_camel(v)
        end
      when Array
        value.map { |v| deep_transform_keys_to_camel(v) }
      else
        value
      end
    end

    # @param value [Object]
    # @return [String]
    sig { params(value: T.untyped).returns(String) }
    def dump_json(value)
      JSON.generate(value)
    end
  end
end
