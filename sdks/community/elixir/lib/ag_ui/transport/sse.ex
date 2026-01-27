defmodule AgUI.Transport.SSE do
  @moduledoc """
  Server-Sent Events (SSE) parser.

  Implements the SSE protocol as defined in the WHATWG HTML Living Standard.
  Handles CRLF/LF line endings, multi-line data, event type, id, and retry fields.

  ## Usage

      # Create a new parser state
      parser = AgUI.Transport.SSE.new()

      # Feed chunks of data and get parsed events
      {events, parser} = AgUI.Transport.SSE.feed(parser, chunk)

      # Stream events from an enumerable of chunks
      stream = AgUI.Transport.SSE.stream_events(chunk_enum)

  ## Event Structure

  Each parsed event is a map with these keys:
  - `:data` - The event data (multiple data lines joined with newlines)
  - `:type` - The event type (defaults to "message")
  - `:id` - The event ID (nil if not specified)
  - `:retry` - Retry timeout in milliseconds (nil if not specified)

  """

  defmodule Parser do
    @moduledoc """
    Incremental parser state for SSE streams.
    """

    @type t :: %__MODULE__{
            buffer: String.t(),
            event_type: String.t() | nil,
            data_lines: [String.t()],
            last_event_id: String.t() | nil,
            retry: non_neg_integer() | nil
          }

    defstruct buffer: "",
              event_type: nil,
              data_lines: [],
              last_event_id: nil,
              retry: nil
  end

  @type event :: %{
          data: String.t(),
          type: String.t(),
          id: String.t() | nil,
          retry: non_neg_integer() | nil
        }

  @doc """
  Creates a new parser state.
  """
  @spec new() :: Parser.t()
  def new, do: %Parser{}

  @doc """
  Returns the last event ID from the parser state.

  This can be used for reconnection with the `Last-Event-ID` header.
  """
  @spec last_event_id(Parser.t()) :: String.t() | nil
  def last_event_id(%Parser{last_event_id: id}), do: id

  @doc """
  Feeds a chunk of data to the parser and returns parsed events.

  Returns a tuple of `{events, updated_parser}` where events is a list
  of parsed SSE events and updated_parser contains any incomplete data
  buffered for the next chunk.

  ## Examples

      iex> parser = AgUI.Transport.SSE.new()
      iex> {events, _parser} = AgUI.Transport.SSE.feed(parser, "data: hello\\n\\n")
      iex> hd(events).data
      "hello"

  """
  @spec feed(Parser.t(), String.t()) :: {[event()], Parser.t()}
  def feed(%Parser{} = parser, chunk) when is_binary(chunk) do
    buffer = parser.buffer <> chunk

    # Split on double newlines (CRLF or LF variants)
    {complete_blocks, remaining} = split_complete_blocks(buffer)

    # Parse each complete block
    {events, parser} =
      Enum.reduce(complete_blocks, {[], parser}, fn block, {events, p} ->
        {new_events, new_parser} = parse_block(block, p)
        {events ++ new_events, new_parser}
      end)

    {events, %{parser | buffer: remaining}}
  end

  @doc """
  Finalizes the parser, returning any pending events.

  Call this when the stream ends to flush any remaining buffered data.
  """
  @spec finalize(Parser.t()) :: {[event()], Parser.t()}
  def finalize(%Parser{} = parser) do
    if parser.buffer != "" or parser.data_lines != [] do
      # Try to parse remaining buffer as a block
      {events, parser} = parse_block(parser.buffer, parser)
      # Dispatch any pending event
      {final_events, parser} = dispatch_event(parser)
      {events ++ final_events, %{parser | buffer: ""}}
    else
      {[], parser}
    end
  end

  @doc """
  Creates a stream of SSE events from an enumerable of chunks.

  ## Options

  - `:parser` - Initial parser state (defaults to a new parser)

  ## Examples

      chunk_stream
      |> AgUI.Transport.SSE.stream_events()
      |> Enum.each(fn event -> IO.puts(event.data) end)

  """
  @spec stream_events(Enumerable.t(), keyword()) :: Enumerable.t()
  def stream_events(enum, opts \\ []) do
    parser = Keyword.get(opts, :parser, new())

    Stream.transform(
      enum,
      fn -> parser end,
      fn chunk, parser ->
        {events, parser} = feed(parser, chunk)
        {events, parser}
      end,
      fn parser ->
        {events, _parser} = finalize(parser)
        {events, nil}
      end,
      fn _ -> :ok end
    )
  end

  @doc """
  Decodes all events from a complete SSE body string.

  ## Examples

      iex> events = AgUI.Transport.SSE.decode_events("data: event1\\n\\ndata: event2\\n\\n")
      iex> Enum.map(events, & &1.data)
      ["event1", "event2"]

  """
  @spec decode_events(String.t()) :: [event()]
  def decode_events(body) when is_binary(body) do
    {events, parser} = feed(new(), body)
    {final_events, _} = finalize(parser)
    events ++ final_events
  end

  # Split buffer into complete event blocks and remaining incomplete data
  defp split_complete_blocks(buffer) do
    # Split on double newline (handling CRLF and LF)
    # Pattern: \r\n\r\n or \n\n or \r\n\n or \n\r\n
    parts = String.split(buffer, ~r/\r?\n\r?\n/, trim: false)

    case parts do
      [] ->
        {[], ""}

      [single] ->
        # No complete block yet
        {[], single}

      parts ->
        # Last part is incomplete (or empty if buffer ended with double newline)
        {complete, [remaining]} = Enum.split(parts, -1)
        # Filter out empty blocks
        {Enum.reject(complete, &(&1 == "")), remaining}
    end
  end

  # Parse a complete event block (text between double newlines)
  defp parse_block(block, parser) do
    lines = String.split(block, ~r/\r?\n/)

    parser =
      Enum.reduce(lines, parser, fn line, p ->
        parse_line(line, p)
      end)

    # After processing all lines in a block, dispatch the event
    dispatch_event(parser)
  end

  # Parse a single line according to SSE spec
  defp parse_line("", parser) do
    # Empty line - should not happen within a block, but handle gracefully
    parser
  end

  defp parse_line(":" <> _rest, parser) do
    # Comment line, ignore
    parser
  end

  defp parse_line(line, parser) do
    case String.split(line, ":", parts: 2) do
      [field, value] ->
        # Remove single leading space from value if present
        value = remove_leading_space(value)
        process_field(field, value, parser)

      [field] ->
        # Field with no value
        process_field(field, "", parser)
    end
  end

  defp remove_leading_space(" " <> rest), do: rest
  defp remove_leading_space(value), do: value

  defp process_field("event", value, parser) do
    %{parser | event_type: value}
  end

  defp process_field("data", value, parser) do
    %{parser | data_lines: parser.data_lines ++ [value]}
  end

  defp process_field("id", value, parser) do
    # Per spec, ignore id fields containing U+0000 NULL
    if String.contains?(value, <<0>>) do
      parser
    else
      %{parser | last_event_id: value}
    end
  end

  defp process_field("retry", value, parser) do
    case Integer.parse(value) do
      {ms, ""} when ms >= 0 ->
        %{parser | retry: ms}

      _ ->
        # Ignore invalid retry values
        parser
    end
  end

  defp process_field(_field, _value, parser) do
    # Unknown field, ignore
    parser
  end

  # Dispatch a complete event and reset event-specific state
  defp dispatch_event(parser) do
    if parser.data_lines == [] do
      # No data, no event to dispatch
      {[], reset_event_state(parser)}
    else
      event = %{
        data: Enum.join(parser.data_lines, "\n"),
        type: parser.event_type || "message",
        id: parser.last_event_id,
        retry: parser.retry
      }

      {[event], reset_event_state(parser)}
    end
  end

  defp reset_event_state(parser) do
    %{parser | event_type: nil, data_lines: [], retry: nil}
  end
end
