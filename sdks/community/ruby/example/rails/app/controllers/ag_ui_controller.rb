require "securerandom"
require "ag_ui_protocol"

class AgUiController < ActionController::API
  include ActionController::Live

  def run
    encoder = AgUiProtocol::Encoder::EventEncoder.new(accept: request.headers["Accept"])

    response.headers["Content-Type"] = encoder.content_type
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"

    thread_id = params[:thread_id] || SecureRandom.uuid
    run_id = params[:run_id] || SecureRandom.uuid

    response.stream.write(encoder.encode(
      AgUiProtocol::Core::Events::RunStartedEvent.new(
        thread_id: thread_id,
        run_id: run_id
      )
    ))
    response.stream.flush if response.stream.respond_to?(:flush)

    message_id = SecureRandom.uuid

    response.stream.write(encoder.encode(
      AgUiProtocol::Core::Events::TextMessageStartEvent.new(message_id: message_id)
    ))
    response.stream.flush if response.stream.respond_to?(:flush)

    response.stream.write(encoder.encode(
      AgUiProtocol::Core::Events::TextMessageContentEvent.new(
        message_id: message_id,
        delta: "Hello world!"
      )
    ))
    response.stream.flush if response.stream.respond_to?(:flush)

    response.stream.write(encoder.encode(
      AgUiProtocol::Core::Events::TextMessageEndEvent.new(message_id: message_id)
    ))
    response.stream.flush if response.stream.respond_to?(:flush)

    response.stream.write(encoder.encode(
      AgUiProtocol::Core::Events::RunFinishedEvent.new(
        thread_id: thread_id,
        run_id: run_id
      )
    ))
    response.stream.flush if response.stream.respond_to?(:flush)
  rescue StandardError => e
    begin
      encoder ||= AgUiProtocol::Encoder::EventEncoder.new(accept: request.headers["Accept"])
      response.stream.write(encoder.encode(
        AgUiProtocol::Core::Events::RunErrorEvent.new(message: e.message)
      ))
      response.stream.flush if response.stream.respond_to?(:flush)
    rescue StandardError
    end
  ensure
    response.stream.close
  end
end
