package encoding

import (
	"context"
	"fmt"
	"io"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// ==============================================================================
// CORE SINGLE-PURPOSE INTERFACES (Interface Segregation Principle)
// ==============================================================================

// Encoder defines the interface for encoding events to bytes
type Encoder interface {
	// Encode encodes a single event
	Encode(ctx context.Context, event events.Event) ([]byte, error)

	// EncodeMultiple encodes multiple events efficiently
	EncodeMultiple(ctx context.Context, events []events.Event) ([]byte, error)

	// ContentType returns the MIME type for this encoder
	ContentType() string
}

// Decoder defines the interface for decoding events from bytes
type Decoder interface {
	// Decode decodes a single event from raw data
	Decode(ctx context.Context, data []byte) (events.Event, error)

	// DecodeMultiple decodes multiple events from raw data
	DecodeMultiple(ctx context.Context, data []byte) ([]events.Event, error)

	// ContentType returns the MIME type for this decoder
	ContentType() string
}

// ContentTypeProvider provides MIME type information
type ContentTypeProvider interface {
	// ContentType returns the MIME type for this component
	ContentType() string
}

// StreamingCapabilityProvider indicates streaming support
type StreamingCapabilityProvider interface {
	// SupportsStreaming indicates if this component has streaming capabilities
	SupportsStreaming() bool
}

// ==============================================================================
// STREAMING INTERFACES
// ==============================================================================

// StreamEncoder defines the interface for streaming event encoding
type StreamEncoder interface {
	// EncodeStream encodes events from a channel to a writer
	EncodeStream(ctx context.Context, input <-chan events.Event, output io.Writer) error

	// Session management methods
	StartStream(ctx context.Context, w io.Writer) error
	EndStream(ctx context.Context) error

	// Event processing method
	WriteEvent(ctx context.Context, event events.Event) error

	// ContentType returns the MIME type for this stream encoder
	ContentType() string
}

// StreamDecoder defines the interface for streaming event decoding
type StreamDecoder interface {
	// DecodeStream decodes events from a reader to a channel
	DecodeStream(ctx context.Context, input io.Reader, output chan<- events.Event) error

	// Session management methods
	StartStream(ctx context.Context, r io.Reader) error
	EndStream(ctx context.Context) error

	// Event processing method
	ReadEvent(ctx context.Context) (events.Event, error)

	// ContentType returns the MIME type for this stream decoder
	ContentType() string
}

// StreamSessionManager manages streaming sessions
type StreamSessionManager interface {
	// StartEncodingSession initializes a streaming encoding session
	StartEncodingSession(ctx context.Context, w io.Writer) error

	// StartDecodingSession initializes a streaming decoding session
	StartDecodingSession(ctx context.Context, r io.Reader) error

	// EndSession finalizes the current streaming session
	EndSession(ctx context.Context) error
}

// StreamEventProcessor processes individual events in a stream
type StreamEventProcessor interface {
	// WriteEvent writes a single event to the encoding stream
	WriteEvent(ctx context.Context, event events.Event) error

	// ReadEvent reads a single event from the decoding stream
	ReadEvent(ctx context.Context) (events.Event, error)
}

// ==============================================================================
// VALIDATION INTERFACES
// ==============================================================================

// Validator provides basic validation capabilities
type Validator interface {
	// Validate validates data according to component-specific rules
	Validate(ctx context.Context, data interface{}) error
}

// OutputValidator validates encoded output
type OutputValidator interface {
	// ValidateOutput validates that encoded data is correct
	ValidateOutput(ctx context.Context, data []byte) error
}

// InputValidator validates decoded input
type InputValidator interface {
	// ValidateInput validates that input data can be decoded
	ValidateInput(ctx context.Context, data []byte) error
}

// ==============================================================================
// COMPOSITE INTERFACES (Built through composition)
// ==============================================================================

// Codec combines encoding and decoding with content type information
// This is a convenience interface for components that need both operations
type Codec interface {
	Encoder
	Decoder
	ContentTypeProvider
	StreamingCapabilityProvider
}

// StreamCodec combines streaming encoding and decoding
type StreamCodec interface {
	Encoder // Basic encoding operations
	Decoder // Basic decoding operations
	ContentTypeProvider
	StreamingCapabilityProvider

	// Streaming operations (delegated to components)
	EncodeStream(ctx context.Context, input <-chan events.Event, output io.Writer) error
	DecodeStream(ctx context.Context, input io.Reader, output chan<- events.Event) error

	// Session management methods (legacy compatibility)
	StartEncoding(ctx context.Context, w io.Writer) error
	WriteEvent(ctx context.Context, event events.Event) error
	EndEncoding(ctx context.Context) error
	StartDecoding(ctx context.Context, r io.Reader) error
	ReadEvent(ctx context.Context) (events.Event, error)
	EndDecoding(ctx context.Context) error

	// Stream component access methods
	GetStreamEncoder() StreamEncoder
	GetStreamDecoder() StreamDecoder
}

// FullStreamCodec provides complete streaming functionality
// This includes both basic and streaming operations with session management
type FullStreamCodec interface {
	Codec                // Basic encode/decode operations
	StreamCodec          // Stream operations
	StreamSessionManager // Session management
	StreamEventProcessor // Event-level streaming
}

// ValidatingCodec adds validation capabilities to basic codec operations
type ValidatingCodec interface {
	Codec
	OutputValidator
	InputValidator
}

// ==============================================================================
// CONFIGURATION AND ERROR TYPES
// ==============================================================================

// EncodingOptions provides options for encoding operations
type EncodingOptions struct {
	// Pretty indicates if output should be formatted for readability
	Pretty bool

	// Compression specifies compression algorithm (e.g., "gzip", "zstd")
	Compression string

	// BufferSize specifies buffer size for streaming operations
	BufferSize int

	// MaxSize specifies maximum encoded size (0 for unlimited)
	MaxSize int64

	// ValidateOutput enables output validation after encoding
	ValidateOutput bool

	// CrossSDKCompatibility ensures compatibility with other SDKs
	CrossSDKCompatibility bool
}

// Validate validates the encoding options
func (opts *EncodingOptions) Validate() error {
	if opts == nil {
		return nil // nil options are acceptable, defaults will be used
	}

	// Validate buffer size
	if opts.BufferSize < 0 {
		return fmt.Errorf("buffer size cannot be negative, got %d", opts.BufferSize)
	}

	// Validate max size
	if opts.MaxSize < 0 {
		return fmt.Errorf("max size cannot be negative, got %d", opts.MaxSize)
	}

	// Validate compression algorithm
	if opts.Compression != "" {
		validCompressions := []string{"gzip", "zstd", "lz4", "deflate"}
		valid := false
		for _, comp := range validCompressions {
			if opts.Compression == comp {
				valid = true
				break
			}
		}
		if !valid {
			return fmt.Errorf("unsupported compression algorithm %q, supported: %v", opts.Compression, validCompressions)
		}
	}

	return nil
}

// DecodingOptions provides options for decoding operations
type DecodingOptions struct {
	// Strict enables strict validation during decoding
	Strict bool

	// MaxSize specifies maximum input size to process (0 for unlimited)
	MaxSize int64

	// BufferSize specifies buffer size for streaming operations
	BufferSize int

	// AllowUnknownFields allows unknown fields in the input
	AllowUnknownFields bool

	// ValidateEvents enables event validation after decoding
	ValidateEvents bool
}

// Validate validates the decoding options
func (opts *DecodingOptions) Validate() error {
	if opts == nil {
		return nil // nil options are acceptable, defaults will be used
	}

	// Validate buffer size
	if opts.BufferSize < 0 {
		return fmt.Errorf("buffer size cannot be negative, got %d", opts.BufferSize)
	}

	// Validate max size
	if opts.MaxSize < 0 {
		return fmt.Errorf("max size cannot be negative, got %d", opts.MaxSize)
	}

	return nil
}

// EncodingError represents an error during encoding
type EncodingError struct {
	Format  string
	Event   events.Event
	Message string
	Cause   error
}

func (e *EncodingError) Error() string {
	if e.Cause != nil {
		return "encoding error: " + e.Message + ": " + e.Cause.Error()
	}
	return "encoding error: " + e.Message
}

func (e *EncodingError) Unwrap() error {
	return e.Cause
}

// DecodingError represents an error during decoding
type DecodingError struct {
	Format  string
	Data    []byte
	Message string
	Cause   error
}

func (e *DecodingError) Error() string {
	if e.Cause != nil {
		return "decoding error: " + e.Message + ": " + e.Cause.Error()
	}
	return "decoding error: " + e.Message
}

func (e *DecodingError) Unwrap() error {
	return e.Cause
}

// ==============================================================================
// FACTORY AND UTILITY INTERFACES
// ==============================================================================

// ContentNegotiator defines the interface for content type negotiation
type ContentNegotiator interface {
	// Negotiate selects the best content type based on Accept header
	Negotiate(acceptHeader string) (string, error)

	// SupportedTypes returns list of supported content types
	SupportedTypes() []string

	// PreferredType returns the preferred content type
	PreferredType() string

	// CanHandle checks if a content type can be handled
	CanHandle(contentType string) bool

	// AddFormat adds a format with its priority/quality value
	AddFormat(contentType string, priority float64) error
}

// CodecFactory creates codecs for specific content types
// This interface is focused on the core factory responsibility
type CodecFactory interface {
	// CreateCodec creates a basic codec for the specified content type
	CreateCodec(ctx context.Context, contentType string, encOptions *EncodingOptions, decOptions *DecodingOptions) (Codec, error)

	// SupportedTypes returns list of supported content types
	SupportedTypes() []string
}

// StreamCodecFactory creates streaming codecs
// Separated from CodecFactory to follow Interface Segregation Principle
type StreamCodecFactory interface {
	// CreateStreamCodec creates a streaming codec for the specified content type
	CreateStreamCodec(ctx context.Context, contentType string, encOptions *EncodingOptions, decOptions *DecodingOptions) (StreamCodec, error)

	// SupportsStreaming indicates if streaming is supported for the given content type
	SupportsStreaming(contentType string) bool
}

// FullCodecFactory combines basic and streaming codec creation
// This is a convenience interface for factories that support both
type FullCodecFactory interface {
	CodecFactory
	StreamCodecFactory
}
