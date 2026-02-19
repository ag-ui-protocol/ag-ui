# typed: true
# frozen_string_literal: true

require "sorbet-runtime"

require_relative "ag_ui_protocol/version"
require_relative "ag_ui_protocol/util"
require_relative "ag_ui_protocol/core/types"
require_relative "ag_ui_protocol/core/events"
require_relative "ag_ui_protocol/encoder/event_encoder"

module AgUiProtocol
  AGUI_MEDIA_TYPE = Encoder::AGUI_MEDIA_TYPE
  EventEncoder = Encoder::EventEncoder
end
