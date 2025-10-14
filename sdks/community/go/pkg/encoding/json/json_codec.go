package json

import (
	"context"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
)

// JSONCodec implements the new Codec interface for JSON encoding/decoding
// It properly composes the focused Encoder, Decoder, and ContentTypeProvider interfaces
type JSONCodec struct {
	*JSONEncoder
	*JSONDecoder
}

// Ensure JSONCodec implements the core interfaces
var (
	_ encoding.Encoder             = (*JSONCodec)(nil)
	_ encoding.Decoder             = (*JSONCodec)(nil)
	_ encoding.ContentTypeProvider = (*JSONCodec)(nil)
	_ encoding.Codec               = (*JSONCodec)(nil)
)

// NewJSONCodec creates a new JSON codec with the given options
func NewJSONCodec(encOptions *encoding.EncodingOptions, decOptions *encoding.DecodingOptions) *JSONCodec {
	return &JSONCodec{
		JSONEncoder: NewJSONEncoder(encOptions),
		JSONDecoder: NewJSONDecoder(decOptions),
	}
}

// NewDefaultJSONCodec creates a new JSON codec with default options
func NewDefaultJSONCodec() *JSONCodec {
	return NewJSONCodec(
		&encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
		},
		&encoding.DecodingOptions{
			Strict:         true,
			ValidateEvents: true,
		},
	)
}

// Encode delegates to the encoder
func (c *JSONCodec) Encode(ctx context.Context, event events.Event) ([]byte, error) {
	return c.JSONEncoder.Encode(ctx, event)
}

// EncodeMultiple delegates to the encoder
func (c *JSONCodec) EncodeMultiple(ctx context.Context, events []events.Event) ([]byte, error) {
	return c.JSONEncoder.EncodeMultiple(ctx, events)
}

// Decode delegates to the decoder
func (c *JSONCodec) Decode(ctx context.Context, data []byte) (events.Event, error) {
	return c.JSONDecoder.Decode(ctx, data)
}

// DecodeMultiple delegates to the decoder
func (c *JSONCodec) DecodeMultiple(ctx context.Context, data []byte) ([]events.Event, error) {
	return c.JSONDecoder.DecodeMultiple(ctx, data)
}

// ContentType returns the MIME type for JSON
func (c *JSONCodec) ContentType() string {
	return "application/json"
}

// SupportsStreaming indicates that JSON codec supports streaming
func (c *JSONCodec) SupportsStreaming() bool {
	return true
}

// CanStream indicates that JSON codec supports streaming (backward compatibility)
// This method is provided for backward compatibility with legacy interfaces
func (c *JSONCodec) CanStream() bool {
	return c.SupportsStreaming()
}

// CodecOptions provides combined options for JSON codec
type CodecOptions struct {
	EncodingOptions *encoding.EncodingOptions
	DecodingOptions *encoding.DecodingOptions
}

// DefaultCodecOptions returns default codec options
func DefaultCodecOptions() *CodecOptions {
	return &CodecOptions{
		EncodingOptions: &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
			Pretty:                false,
			BufferSize:            4096,
		},
		DecodingOptions: &encoding.DecodingOptions{
			Strict:             true,
			ValidateEvents:     true,
			AllowUnknownFields: false,
			BufferSize:         4096,
		},
	}
}

// PrettyCodecOptions returns codec options for pretty-printed JSON
func PrettyCodecOptions() *CodecOptions {
	opts := DefaultCodecOptions()
	opts.EncodingOptions.Pretty = true
	return opts
}

// CompatibilityCodecOptions returns codec options optimized for cross-SDK compatibility
func CompatibilityCodecOptions() *CodecOptions {
	return &CodecOptions{
		EncodingOptions: &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
			Pretty:                false,
			BufferSize:            8192,
		},
		DecodingOptions: &encoding.DecodingOptions{
			Strict:             false,
			ValidateEvents:     true,
			AllowUnknownFields: true,
			BufferSize:         8192,
		},
	}
}

// StreamingCodecOptions returns codec options optimized for streaming
func StreamingCodecOptions() *CodecOptions {
	return &CodecOptions{
		EncodingOptions: &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        false, // Skip validation for performance
			Pretty:                false,
			BufferSize:            16384, // Larger buffer for streaming
		},
		DecodingOptions: &encoding.DecodingOptions{
			Strict:             false,
			ValidateEvents:     false, // Skip validation for performance
			AllowUnknownFields: true,
			BufferSize:         16384, // Larger buffer for streaming
		},
	}
}
