package negotiation

import (
	"sort"
)

// SelectionCriteria defines the criteria for content type selection
type SelectionCriteria struct {
	// PreferPerformance weights performance higher in selection
	PreferPerformance bool
	// MinQuality is the minimum acceptable quality factor
	MinQuality float64
	// RequireStreaming requires streaming support
	RequireStreaming bool
	// PreferredCompression lists preferred compression algorithms
	PreferredCompression []string
	// ClientCapabilities describes client capabilities
	ClientCapabilities *ClientCapabilities
}

// ClientCapabilities describes what the client can handle
type ClientCapabilities struct {
	// SupportsStreaming indicates if client supports streaming
	SupportsStreaming bool
	// CompressionSupport lists supported compression algorithms
	CompressionSupport []string
	// MaxPayloadSize is the maximum payload size client can handle
	MaxPayloadSize int64
	// PreferredFormats lists client's preferred formats in order
	PreferredFormats []string
}

// FormatSelector implements intelligent format selection algorithms
type FormatSelector struct {
	negotiator *ContentNegotiator
	criteria   SelectionCriteria
}

// NewFormatSelector creates a new format selector
func NewFormatSelector(negotiator *ContentNegotiator) *FormatSelector {
	return &FormatSelector{
		negotiator: negotiator,
		criteria: SelectionCriteria{
			MinQuality: 0.1, // Default minimum quality
		},
	}
}

// SelectFormat selects the best format based on multiple criteria
func (fs *FormatSelector) SelectFormat(acceptHeader string, criteria *SelectionCriteria) (string, error) {
	if criteria != nil {
		fs.criteria = *criteria
	}

	// Parse Accept header
	acceptTypes, err := ParseAcceptHeader(acceptHeader)
	if err != nil {
		return "", err
	}

	// Filter by minimum quality
	acceptTypes = fs.filterByQuality(acceptTypes)

	// Get candidates
	candidates := fs.getCandidates(acceptTypes)

	return fs.selectByQuality(candidates)
}

// filterByQuality filters accept types by minimum quality
func (fs *FormatSelector) filterByQuality(types []AcceptType) []AcceptType {
	var filtered []AcceptType
	for _, t := range types {
		if t.Quality >= fs.criteria.MinQuality {
			filtered = append(filtered, t)
		}
	}
	return filtered
}

// Candidate represents a content type candidate for selection
type Candidate struct {
	ContentType   string
	Quality       float64
	Capabilities  *TypeCapabilities
	MatchedAccept AcceptType
}

// getCandidates gets all matching candidates
func (fs *FormatSelector) getCandidates(acceptTypes []AcceptType) []Candidate {
	var candidates []Candidate

	for _, acceptType := range acceptTypes {
		for _, supportedType := range fs.negotiator.SupportedTypes() {
			if matched, quality := fs.matchType(supportedType, acceptType); matched {
				capabilities, _ := fs.negotiator.GetCapabilities(supportedType)

				candidate := Candidate{
					ContentType:   supportedType,
					Quality:       quality,
					Capabilities:  capabilities,
					MatchedAccept: acceptType,
				}

				// Apply filters
				if fs.shouldIncludeCandidate(candidate) {
					candidates = append(candidates, candidate)
				}
			}
		}
	}

	return candidates
}

// shouldIncludeCandidate checks if a candidate meets all criteria
func (fs *FormatSelector) shouldIncludeCandidate(candidate Candidate) bool {
	// Check streaming requirement
	if fs.criteria.RequireStreaming && !candidate.Capabilities.CanStream {
		return false
	}

	// Check client capabilities
	if fs.criteria.ClientCapabilities != nil {
		if !fs.checkClientCompatibility(candidate) {
			return false
		}
	}

	return true
}

// checkClientCompatibility checks if candidate is compatible with client
func (fs *FormatSelector) checkClientCompatibility(candidate Candidate) bool {
	client := fs.criteria.ClientCapabilities

	// Check streaming compatibility
	if candidate.Capabilities.CanStream && !client.SupportsStreaming {
		return false
	}

	// Check compression compatibility
	if len(fs.criteria.PreferredCompression) > 0 {
		hasCompatibleCompression := false
		for _, clientComp := range client.CompressionSupport {
			for _, serverComp := range candidate.Capabilities.CompressionSupport {
				if clientComp == serverComp {
					hasCompatibleCompression = true
					break
				}
			}
		}
		if !hasCompatibleCompression {
			return false
		}
	}

	return true
}

// selectByQuality selects the best candidate based on quality
func (fs *FormatSelector) selectByQuality(candidates []Candidate) (string, error) {
	if len(candidates) == 0 {
		return "", ErrNoAcceptableType
	}

	// Sort by quality, then server priority, then performance
	sort.Slice(candidates, func(i, j int) bool {
		// Quality is primary sort key
		if candidates[i].Quality != candidates[j].Quality {
			return candidates[i].Quality > candidates[j].Quality
		}
		// Server priority is secondary sort key
		if candidates[i].Capabilities.Priority != candidates[j].Capabilities.Priority {
			return candidates[i].Capabilities.Priority > candidates[j].Capabilities.Priority
		}
		return false
	})

	return candidates[0].ContentType, nil
}

// matchType checks if a content type matches an accept type
func (fs *FormatSelector) matchType(contentType string, acceptType AcceptType) (bool, float64) {
	// Use negotiator's match logic
	return fs.negotiator.matchType(contentType, acceptType)
}

// SetCriteria updates the selection criteria
func (fs *FormatSelector) SetCriteria(criteria SelectionCriteria) {
	fs.criteria = criteria
}

// GetCriteria returns the current selection criteria
func (fs *FormatSelector) GetCriteria() SelectionCriteria {
	return fs.criteria
}
