package json

import (
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
)

// Default codec instances for convenience
var (
	// DefaultCodec is a pre-configured JSON codec with default options
	DefaultCodec = NewDefaultJSONCodec()

	// PrettyCodec is a pre-configured JSON codec that produces pretty-printed output
	PrettyCodec = NewJSONCodec(PrettyCodecOptions().EncodingOptions, PrettyCodecOptions().DecodingOptions)

	// CompatibilityCodec is optimized for cross-SDK compatibility
	CompatibilityCodec = NewJSONCodec(CompatibilityCodecOptions().EncodingOptions, CompatibilityCodecOptions().DecodingOptions)
)

// Factory functions for creating encoders and decoders

// NewEncoder creates a JSON encoder with default options
func NewEncoder() encoding.Encoder {
	return NewJSONEncoder(nil)
}

// NewDecoder creates a JSON decoder with default options
func NewDecoder() encoding.Decoder {
	return NewJSONDecoder(nil)
}

// NewCodec creates a JSON codec with default options
func NewCodec() encoding.Codec {
	return NewDefaultJSONCodec()
}
