require "securerandom"
require "ag_ui_protocol"

class AgUiController < ActionController::API

  def run
    encoder = AgUiProtocol::Encoder::EventEncoder.new(accept: request.headers["Accept"])
    thread_id = params[:thread_id] || SecureRandom.uuid
    run_id = params[:run_id] || SecureRandom.uuid

    with_stream(encoder.content_type) do |stream|
      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::RunStartedEvent.new(
          thread_id: thread_id,
          run_id: run_id
        )
      ))
      stream.flush if stream.respond_to?(:flush)

      message_id = SecureRandom.uuid

      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::TextMessageStartEvent.new(message_id: message_id)
      ))
      stream.flush if stream.respond_to?(:flush)

      # sleep to simulate processing, in a real application this would be the agent processing the message
      sleep(1)

      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::TextMessageContentEvent.new(
          message_id: message_id,
          delta: "Hello world!"
        )
      ))
      stream.flush if stream.respond_to?(:flush)

      # sleep to simulate processing
      sleep(1)

      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::TextMessageEndEvent.new(message_id: message_id)
      ))
      stream.flush if stream.respond_to?(:flush)

      # sleep to simulate processing
      sleep(1)

      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::RunFinishedEvent.new(
          thread_id: thread_id,
          run_id: run_id
        )
      ))
      stream.flush if stream.respond_to?(:flush)
    rescue StandardError => e
      encoder ||= AgUiProtocol::Encoder::EventEncoder.new(accept: request.headers["Accept"])
      stream.write(encoder.encode(
        AgUiProtocol::Core::Events::RunErrorEvent.new(message: e.message)
      ))
      raise e
    end

    head :ok
  end

  private

    def with_stream content_type
      response.headers["Content-Type"] = content_type
      response.headers["Cache-Control"] = "no-cache"
      response.headers["X-Accel-Buffering"] = "no"

      response.headers["rack.hijack"] = proc do |stream|
        Thread.new do
          yield stream
        rescue => e
          Rails.logger.error "Stream error: #{e.message}"
          stream.flush if stream.respond_to?(:flush)
        ensure
          stream.close
        end
      rescue IOError
        Rails.logger.warn "Client disconnected"
      end
    end
end
