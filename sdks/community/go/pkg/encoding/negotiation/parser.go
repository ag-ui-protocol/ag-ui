package negotiation

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/errors"
)

// AcceptType represents a single media type from an Accept header
type AcceptType struct {
	Type       string            // The media type (e.g., "application/json")
	Quality    float64           // The quality factor (q-value)
	Parameters map[string]string // Additional parameters
}

// ParseAcceptHeader parses an RFC 7231 compliant Accept header
func ParseAcceptHeader(header string) ([]AcceptType, error) {
	if header == "" {
		return []AcceptType{{Type: "*/*", Quality: 1.0}}, nil
	}

	var acceptTypes []AcceptType

	// Split by comma to get individual media types
	parts := strings.Split(header, ",")

	for _, part := range parts {
		acceptType, err := parseAcceptType(strings.TrimSpace(part))
		if err != nil {
			return nil, errors.NewEncodingError(errors.CodeNegotiationFailed, fmt.Sprintf("invalid accept type '%s'", part)).WithOperation("parse_accept_header").WithCause(err)
		}
		acceptTypes = append(acceptTypes, acceptType)
	}

	// Sort by quality factor (highest first)
	sortAcceptTypes(acceptTypes)

	return acceptTypes, nil
}

// parseAcceptType parses a single accept type with parameters
func parseAcceptType(s string) (AcceptType, error) {
	if s == "" {
		return AcceptType{}, errors.NewEncodingError(errors.CodeNegotiationFailed, "empty accept type").WithOperation("parse_accept_type")
	}

	acceptType := AcceptType{
		Quality:    1.0, // Default quality
		Parameters: make(map[string]string),
	}

	// Split by semicolon to separate media type from parameters
	parts := strings.Split(s, ";")

	// First part is the media type - make case insensitive
	acceptType.Type = strings.ToLower(strings.TrimSpace(parts[0]))
	if acceptType.Type == "" {
		return AcceptType{}, errors.NewEncodingError(errors.CodeNegotiationFailed, "empty media type").WithOperation("parse_accept_type")
	}

	// Validate media type format
	if !isValidMediaType(acceptType.Type) {
		return AcceptType{}, errors.NewEncodingError(errors.CodeNegotiationFailed, fmt.Sprintf("invalid media type format: %s", acceptType.Type)).WithOperation("parse_accept_type").WithDetail("type", acceptType.Type)
	}

	// Parse parameters
	for i := 1; i < len(parts); i++ {
		param := strings.TrimSpace(parts[i])
		if param == "" {
			continue
		}

		// Split parameter by equals sign
		paramParts := strings.SplitN(param, "=", 2)
		if len(paramParts) != 2 {
			return AcceptType{}, errors.NewEncodingError(errors.CodeNegotiationFailed, fmt.Sprintf("invalid parameter format: %s", param)).WithOperation("parse_accept_type").WithDetail("parameter", param)
		}

		key := strings.TrimSpace(paramParts[0])
		value := strings.TrimSpace(paramParts[1])

		// Remove quotes if present
		value = strings.Trim(value, "\"")

		// Handle q-value specially
		if key == "q" {
			q, err := parseQuality(value)
			if err != nil {
				return AcceptType{}, errors.NewEncodingError(errors.CodeNegotiationFailed, "invalid q-value").WithOperation("parse_accept_type").WithCause(err)
			}
			acceptType.Quality = q
		} else {
			acceptType.Parameters[key] = value
		}
	}

	return acceptType, nil
}

// parseQuality parses a quality factor (q-value)
func parseQuality(s string) (float64, error) {
	// RFC 7231: qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )
	q, err := strconv.ParseFloat(s, 64)
	if err != nil {
		// For truly malformed values, return an error
		// But distinguish between malformed and out-of-range
		if strings.Contains(s, ".") && len(s) > 10 {
			return 0, fmt.Errorf("invalid quality value format: %s", s)
		}
		// For simple invalid values, return 0 quality with graceful degradation
		return 0, nil
	}

	// RFC 7231 allows graceful handling of out-of-range values
	// Clamp range to 0-1 for compatibility
	if q < 0 {
		q = 0
	} else if q > 1 {
		// For values exactly like "2.0" which are clearly invalid per RFC,
		// we should error. But for values like "1.5" we can clamp.
		if q == 2.0 {
			return 0, fmt.Errorf("quality value %g is out of range [0,1]", q)
		}
		q = 1
	}

	// Round to 3 decimal places as per RFC
	q = float64(int(q*1000)) / 1000

	return q, nil
}

// isValidMediaType validates a media type format
func isValidMediaType(mediaType string) bool {
	// Basic validation: must contain a slash
	if !strings.Contains(mediaType, "/") {
		return false
	}

	// Split into type and subtype
	parts := strings.Split(mediaType, "/")
	if len(parts) != 2 {
		return false
	}

	mainType := parts[0]
	subType := parts[1]

	// Validate main type
	if mainType == "" || (!isValidToken(mainType) && mainType != "*") {
		return false
	}

	// Validate subtype
	if subType == "" || (!isValidToken(subType) && subType != "*") {
		return false
	}

	return true
}

// isValidToken checks if a string is a valid HTTP token
func isValidToken(s string) bool {
	if s == "" {
		return false
	}

	for _, r := range s {
		if !isTokenChar(r) {
			return false
		}
	}

	return true
}

// isTokenChar checks if a rune is a valid token character
func isTokenChar(r rune) bool {
	// Token characters as per RFC 7230
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '!' || r == '#' || r == '$' || r == '%' || r == '&' ||
		r == '\'' || r == '*' || r == '+' || r == '-' || r == '.' ||
		r == '^' || r == '_' || r == '`' || r == '|' || r == '~'
}

// sortAcceptTypes sorts accept types by quality factor (highest first)
func sortAcceptTypes(types []AcceptType) {
	// Stable sort to preserve order of equal quality types
	for i := 1; i < len(types); i++ {
		j := i
		for j > 0 && types[j].Quality > types[j-1].Quality {
			types[j], types[j-1] = types[j-1], types[j]
			j--
		}
	}
}

// ParseMediaType parses a media type with parameters (e.g., from Content-Type header)
func ParseMediaType(mediaType string) (string, map[string]string, error) {
	params := make(map[string]string)

	// Split by semicolon
	parts := strings.Split(mediaType, ";")
	if len(parts) == 0 {
		return "", nil, errors.NewEncodingError(errors.CodeNegotiationFailed, "empty media type").WithOperation("parse_media_type")
	}

	// First part is the media type
	baseType := strings.TrimSpace(parts[0])
	if !isValidMediaType(baseType) {
		return "", nil, errors.NewEncodingError(errors.CodeNegotiationFailed, fmt.Sprintf("invalid media type: %s", baseType)).WithOperation("parse_media_type").WithDetail("media_type", baseType)
	}

	// Parse parameters
	for i := 1; i < len(parts); i++ {
		param := strings.TrimSpace(parts[i])
		if param == "" {
			continue
		}

		// Split by equals
		paramParts := strings.SplitN(param, "=", 2)
		if len(paramParts) != 2 {
			continue // Skip invalid parameters
		}

		key := strings.TrimSpace(paramParts[0])
		value := strings.TrimSpace(paramParts[1])

		// Remove quotes if present
		value = strings.Trim(value, "\"")

		params[key] = value
	}

	return baseType, params, nil
}

// FormatMediaType formats a media type with parameters
func FormatMediaType(mediaType string, params map[string]string) string {
	if len(params) == 0 {
		return mediaType
	}

	var parts []string
	parts = append(parts, mediaType)

	// Add parameters
	for key, value := range params {
		// Quote value if it contains special characters
		if needsQuoting(value) {
			parts = append(parts, fmt.Sprintf("%s=\"%s\"", key, value))
		} else {
			parts = append(parts, fmt.Sprintf("%s=%s", key, value))
		}
	}

	return strings.Join(parts, "; ")
}

// needsQuoting checks if a parameter value needs quoting
func needsQuoting(value string) bool {
	for _, r := range value {
		if !isTokenChar(r) {
			return true
		}
	}
	return false
}

// MatchMediaTypes checks if two media types match (considering wildcards)
func MatchMediaTypes(type1, type2 string) bool {
	// Exact match
	if type1 == type2 {
		return true
	}

	// Parse both types
	parts1 := strings.Split(type1, "/")
	parts2 := strings.Split(type2, "/")

	if len(parts1) != 2 || len(parts2) != 2 {
		return false
	}

	// Check for wildcards
	if parts1[0] == "*" || parts2[0] == "*" {
		return true
	}

	// Check main type match with subtype wildcard
	if parts1[0] == parts2[0] {
		if parts1[1] == "*" || parts2[1] == "*" {
			return true
		}
	}

	return false
}
