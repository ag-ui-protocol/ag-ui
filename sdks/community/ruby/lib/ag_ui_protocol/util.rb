# typed: true
# frozen_string_literal: true

require "sorbet-runtime"
require "json"

module AgUiProtocol
  # Utility methods for encoding events.
  module Util
    extend T::Sig
    module_function

    # @param value [Object]
    # @return [Object]
    sig { params(value: T.untyped).returns(T.untyped) }
    def normalize_value(value)
      if value.is_a?(AgUiProtocol::Core::Types::Model)
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
