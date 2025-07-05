package events

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ErrorReporter provides detailed error reporting with context
type ErrorReporter struct {
	config *ErrorReportingConfig
}

// ErrorReportingConfig configures error reporting behavior
type ErrorReportingConfig struct {
	IncludeStackTrace   bool `json:"include_stack_trace"`
	IncludeEventContext bool `json:"include_event_context"`
	MaxContextEvents    int  `json:"max_context_events"`
	IncludeSuggestions  bool `json:"include_suggestions"`
	GroupSimilarErrors  bool `json:"group_similar_errors"`
	VerboseMessages     bool `json:"verbose_messages"`
}

// DefaultErrorReportingConfig returns default error reporting configuration
func DefaultErrorReportingConfig() *ErrorReportingConfig {
	return &ErrorReportingConfig{
		IncludeStackTrace:   false,
		IncludeEventContext: true,
		MaxContextEvents:    5,
		IncludeSuggestions:  true,
		GroupSimilarErrors:  true,
		VerboseMessages:     false,
	}
}

// NewErrorReporter creates a new error reporter
func NewErrorReporter(config *ErrorReportingConfig) *ErrorReporter {
	if config == nil {
		config = DefaultErrorReportingConfig()
	}
	
	return &ErrorReporter{
		config: config,
	}
}

// GenerateReport generates a comprehensive error report
func (r *ErrorReporter) GenerateReport(result *ValidationResult, context *ValidationContext) *ErrorReport {
	report := &ErrorReport{
		Summary:   r.generateSummary(result),
		Errors:    r.enhanceErrors(result.Errors, context),
		Warnings:  r.enhanceErrors(result.Warnings, context),
		Context:   r.generateContextInfo(context),
		Timestamp: time.Now(),
	}
	
	if r.config.GroupSimilarErrors {
		report.GroupedErrors = r.groupSimilarErrors(result.Errors)
		report.GroupedWarnings = r.groupSimilarErrors(result.Warnings)
	}
	
	if r.config.IncludeSuggestions {
		report.Recommendations = r.generateRecommendations(result, context)
	}
	
	return report
}

// ErrorReport represents a comprehensive error report
type ErrorReport struct {
	Summary          *ErrorSummary              `json:"summary"`
	Errors           []*EnhancedValidationError `json:"errors,omitempty"`
	Warnings         []*EnhancedValidationError `json:"warnings,omitempty"`
	Context          *ReportContext             `json:"context,omitempty"`
	GroupedErrors    map[string][]*ValidationError `json:"grouped_errors,omitempty"`
	GroupedWarnings  map[string][]*ValidationError `json:"grouped_warnings,omitempty"`
	Recommendations  []*Recommendation          `json:"recommendations,omitempty"`
	Timestamp        time.Time                  `json:"timestamp"`
}

// ErrorSummary provides a high-level summary of validation results
type ErrorSummary struct {
	TotalErrors        int                        `json:"total_errors"`
	TotalWarnings      int                        `json:"total_warnings"`
	TotalEvents        int                        `json:"total_events"`
	ErrorRate          float64                    `json:"error_rate"`
	WarningRate        float64                    `json:"warning_rate"`
	MostCommonError    string                     `json:"most_common_error,omitempty"`
	MostCommonWarning  string                     `json:"most_common_warning,omitempty"`
	CriticalErrors     int                        `json:"critical_errors"`
	ErrorsByType       map[EventType]int          `json:"errors_by_type"`
	ErrorsByRule       map[string]int             `json:"errors_by_rule"`
}

// EnhancedValidationError extends ValidationError with additional context
type EnhancedValidationError struct {
	*ValidationError
	EventContext    *EventContextInfo `json:"event_context,omitempty"`
	SequenceContext *SequenceContextInfo `json:"sequence_context,omitempty"`
	RelatedEvents   []Event           `json:"related_events,omitempty"`
	FixExamples     []*FixExample     `json:"fix_examples,omitempty"`
}

// EventContextInfo provides context about the problematic event
type EventContextInfo struct {
	EventIndex       int                    `json:"event_index"`
	EventJSON        string                 `json:"event_json,omitempty"`
	PreviousEvent    Event                  `json:"previous_event,omitempty"`
	NextEvent        Event                  `json:"next_event,omitempty"`
	ParentEvent      Event                  `json:"parent_event,omitempty"`
	RelatedEventIDs  []string               `json:"related_event_ids,omitempty"`
	StateAtEvent     map[string]interface{} `json:"state_at_event,omitempty"`
}

// SequenceContextInfo provides context about the event sequence
type SequenceContextInfo struct {
	SequenceLength    int       `json:"sequence_length"`
	CurrentPhase      EventPhase `json:"current_phase"`
	ActiveRuns        []string  `json:"active_runs,omitempty"`
	ActiveMessages    []string  `json:"active_messages,omitempty"`
	ActiveTools       []string  `json:"active_tools,omitempty"`
	RecentEventTypes  []EventType `json:"recent_event_types,omitempty"`
	ProtocolViolation bool      `json:"protocol_violation"`
}

// ReportContext provides overall context for the report
type ReportContext struct {
	ValidationConfig  *ValidationConfig     `json:"validation_config,omitempty"`
	SequenceInfo      *SequenceInfo         `json:"sequence_info,omitempty"`
	ValidationMetrics *ValidationMetrics    `json:"validation_metrics,omitempty"`
	Environment       map[string]interface{} `json:"environment,omitempty"`
}

// Recommendation provides actionable recommendations
type Recommendation struct {
	Priority    RecommendationPriority `json:"priority"`
	Category    string                 `json:"category"`
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	Actions     []string               `json:"actions"`
	Examples    []*FixExample          `json:"examples,omitempty"`
	References  []string               `json:"references,omitempty"`
}

// RecommendationPriority defines recommendation priority levels
type RecommendationPriority int

const (
	RecommendationPriorityLow RecommendationPriority = iota
	RecommendationPriorityMedium
	RecommendationPriorityHigh
	RecommendationPriorityCritical
)

func (p RecommendationPriority) String() string {
	switch p {
	case RecommendationPriorityLow:
		return "LOW"
	case RecommendationPriorityMedium:
		return "MEDIUM"
	case RecommendationPriorityHigh:
		return "HIGH"
	case RecommendationPriorityCritical:
		return "CRITICAL"
	default:
		return "UNKNOWN"
	}
}

// FixExample provides examples of how to fix issues
type FixExample struct {
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	Before      map[string]interface{} `json:"before,omitempty"`
	After       map[string]interface{} `json:"after,omitempty"`
	Code        string                 `json:"code,omitempty"`
}

// generateSummary generates an error summary
func (r *ErrorReporter) generateSummary(result *ValidationResult) *ErrorSummary {
	summary := &ErrorSummary{
		TotalErrors:   len(result.Errors),
		TotalWarnings: len(result.Warnings),
		TotalEvents:   result.EventCount,
		ErrorsByType:  make(map[EventType]int),
		ErrorsByRule:  make(map[string]int),
	}
	
	if result.EventCount > 0 {
		summary.ErrorRate = float64(summary.TotalErrors) / float64(result.EventCount)
		summary.WarningRate = float64(summary.TotalWarnings) / float64(result.EventCount)
	}
	
	// Count critical errors
	for _, err := range result.Errors {
		if err.Severity == ValidationSeverityError {
			summary.CriticalErrors++
		}
		summary.ErrorsByType[err.EventType]++
		summary.ErrorsByRule[err.RuleID]++
	}
	
	// Find most common error and warning
	summary.MostCommonError = r.findMostCommonRule(result.Errors)
	summary.MostCommonWarning = r.findMostCommonRule(result.Warnings)
	
	return summary
}

// enhanceErrors enhances errors with additional context
func (r *ErrorReporter) enhanceErrors(errors []*ValidationError, context *ValidationContext) []*EnhancedValidationError {
	enhanced := make([]*EnhancedValidationError, len(errors))
	
	for i, err := range errors {
		enhanced[i] = &EnhancedValidationError{
			ValidationError: err,
		}
		
		if r.config.IncludeEventContext && context != nil {
			enhanced[i].EventContext = r.generateEventContext(err, context)
			enhanced[i].SequenceContext = r.generateSequenceContext(err, context)
			enhanced[i].RelatedEvents = r.findRelatedEvents(err, context)
		}
		
		if r.config.IncludeSuggestions {
			enhanced[i].FixExamples = r.generateFixExamples(err)
		}
	}
	
	return enhanced
}

// generateEventContext generates context information for an event
func (r *ErrorReporter) generateEventContext(err *ValidationError, context *ValidationContext) *EventContextInfo {
	if context.CurrentEvent == nil {
		return nil
	}
	
	eventContext := &EventContextInfo{
		EventIndex: context.EventIndex,
	}
	
	// Include event JSON if configured
	if r.config.VerboseMessages {
		if eventJSON, jsonErr := json.Marshal(context.CurrentEvent); jsonErr == nil {
			eventContext.EventJSON = string(eventJSON)
		}
	}
	
	// Find previous and next events
	if context.EventSequence != nil && len(context.EventSequence) > 0 {
		if context.EventIndex > 0 {
			eventContext.PreviousEvent = context.EventSequence[context.EventIndex-1]
		}
		if context.EventIndex < len(context.EventSequence)-1 {
			eventContext.NextEvent = context.EventSequence[context.EventIndex+1]
		}
	}
	
	// Find related event IDs
	eventContext.RelatedEventIDs = r.findRelatedEventIDs(err, context)
	
	return eventContext
}

// generateSequenceContext generates sequence context information
func (r *ErrorReporter) generateSequenceContext(err *ValidationError, context *ValidationContext) *SequenceContextInfo {
	if context.State == nil {
		return nil
	}
	
	seqContext := &SequenceContextInfo{
		CurrentPhase:      context.State.CurrentPhase,
		ProtocolViolation: r.isProtocolViolation(err),
	}
	
	if context.EventSequence != nil {
		seqContext.SequenceLength = len(context.EventSequence)
		
		// Get recent event types
		start := max(0, len(context.EventSequence)-5)
		for i := start; i < len(context.EventSequence); i++ {
			seqContext.RecentEventTypes = append(seqContext.RecentEventTypes, context.EventSequence[i].Type())
		}
	}
	
	// Get active IDs
	for runID := range context.State.ActiveRuns {
		seqContext.ActiveRuns = append(seqContext.ActiveRuns, runID)
	}
	for msgID := range context.State.ActiveMessages {
		seqContext.ActiveMessages = append(seqContext.ActiveMessages, msgID)
	}
	for toolID := range context.State.ActiveTools {
		seqContext.ActiveTools = append(seqContext.ActiveTools, toolID)
	}
	
	return seqContext
}

// generateContextInfo generates overall context information
func (r *ErrorReporter) generateContextInfo(context *ValidationContext) *ReportContext {
	if context == nil {
		return nil
	}
	
	reportContext := &ReportContext{
		ValidationConfig: context.Config,
		Environment:      make(map[string]interface{}),
	}
	
	if context.State != nil {
		// Create a summary of the sequence info
		reportContext.SequenceInfo = &SequenceInfo{
			TotalEvents:      context.State.EventCount,
			ActiveRuns:       len(context.State.ActiveRuns),
			ActiveMessages:   len(context.State.ActiveMessages),
			ActiveTools:      len(context.State.ActiveTools),
			ActiveSteps:      len(context.State.ActiveSteps),
			FinishedRuns:     len(context.State.FinishedRuns),
			FinishedMessages: len(context.State.FinishedMessages),
			FinishedTools:    len(context.State.FinishedTools),
			CurrentPhase:     context.State.CurrentPhase,
			StartTime:        context.State.StartTime,
			LastEventTime:    context.State.LastEventTime,
		}
	}
	
	// Add environment information
	reportContext.Environment["timestamp"] = time.Now()
	reportContext.Environment["go_version"] = "1.21+"
	reportContext.Environment["ag_ui_version"] = "1.0.0"
	
	return reportContext
}

// groupSimilarErrors groups similar errors together
func (r *ErrorReporter) groupSimilarErrors(errors []*ValidationError) map[string][]*ValidationError {
	groups := make(map[string][]*ValidationError)
	
	for _, err := range errors {
		key := fmt.Sprintf("%s:%s", err.RuleID, err.EventType)
		groups[key] = append(groups[key], err)
	}
	
	return groups
}

// generateRecommendations generates actionable recommendations
func (r *ErrorReporter) generateRecommendations(result *ValidationResult, context *ValidationContext) []*Recommendation {
	var recommendations []*Recommendation
	
	// Analyze error patterns and generate recommendations
	recommendations = append(recommendations, r.analyzeErrorPatterns(result)...)
	recommendations = append(recommendations, r.analyzeSequenceIssues(result, context)...)
	recommendations = append(recommendations, r.analyzePerformanceIssues(result, context)...)
	
	return recommendations
}

// analyzeErrorPatterns analyzes error patterns for recommendations
func (r *ErrorReporter) analyzeErrorPatterns(result *ValidationResult) []*Recommendation {
	var recommendations []*Recommendation
	
	// Count error types
	ruleErrors := make(map[string]int)
	for _, err := range result.Errors {
		ruleErrors[err.RuleID]++
	}
	
	// Generate recommendations based on common errors
	for ruleID, count := range ruleErrors {
		if count >= 3 {
			recommendations = append(recommendations, r.generateRuleRecommendation(ruleID, count))
		}
	}
	
	return recommendations
}

// generateRuleRecommendation generates a recommendation for a specific rule
func (r *ErrorReporter) generateRuleRecommendation(ruleID string, count int) *Recommendation {
	var title, description string
	var actions []string
	var priority RecommendationPriority
	
	switch ruleID {
	case "MESSAGE_LIFECYCLE":
		title = "Fix Message Lifecycle Issues"
		description = fmt.Sprintf("Found %d message lifecycle violations. Ensure proper start→content→end sequences.", count)
		actions = []string{
			"Send TEXT_MESSAGE_START before any content",
			"Send TEXT_MESSAGE_CONTENT between start and end",
			"Send TEXT_MESSAGE_END to complete messages",
		}
		priority = RecommendationPriorityHigh
		
	case "TOOL_CALL_LIFECYCLE":
		title = "Fix Tool Call Lifecycle Issues"
		description = fmt.Sprintf("Found %d tool call lifecycle violations. Ensure proper start→args→end sequences.", count)
		actions = []string{
			"Send TOOL_CALL_START before any arguments",
			"Send TOOL_CALL_ARGS between start and end",
			"Send TOOL_CALL_END to complete tool calls",
		}
		priority = RecommendationPriorityHigh
		
	case "RUN_LIFECYCLE":
		title = "Fix Run Lifecycle Issues"
		description = fmt.Sprintf("Found %d run lifecycle violations. Ensure proper run management.", count)
		actions = []string{
			"Start each sequence with RUN_STARTED",
			"End runs with RUN_FINISHED or RUN_ERROR",
			"Use unique run IDs",
		}
		priority = RecommendationPriorityCritical
		
	default:
		title = fmt.Sprintf("Address %s Rule Violations", ruleID)
		description = fmt.Sprintf("Found %d violations of the %s rule.", count, ruleID)
		actions = []string{
			"Review the specific error messages for this rule",
			"Check the AG-UI protocol documentation",
			"Ensure proper event sequencing",
		}
		priority = RecommendationPriorityMedium
	}
	
	return &Recommendation{
		Priority:    priority,
		Category:    "Error Pattern",
		Title:       title,
		Description: description,
		Actions:     actions,
	}
}

// analyzeSequenceIssues analyzes sequence-related issues
func (r *ErrorReporter) analyzeSequenceIssues(result *ValidationResult, context *ValidationContext) []*Recommendation {
	var recommendations []*Recommendation
	
	if context == nil || context.State == nil {
		return recommendations
	}
	
	// Check for incomplete sequences
	incompleteCount := len(context.State.ActiveMessages) + len(context.State.ActiveTools)
	if incompleteCount > 5 {
		recommendations = append(recommendations, &Recommendation{
			Priority:    RecommendationPriorityMedium,
			Category:    "Sequence Management",
			Title:       "Complete Incomplete Sequences",
			Description: fmt.Sprintf("Found %d incomplete sequences (active messages/tools). This may indicate missing end events.", incompleteCount),
			Actions: []string{
				"Review active messages and send TEXT_MESSAGE_END events",
				"Review active tool calls and send TOOL_CALL_END events",
				"Implement proper cleanup logic in your application",
			},
		})
	}
	
	return recommendations
}

// analyzePerformanceIssues analyzes performance-related issues
func (r *ErrorReporter) analyzePerformanceIssues(result *ValidationResult, context *ValidationContext) []*Recommendation {
	var recommendations []*Recommendation
	
	// Check validation duration
	if result.Duration > time.Second {
		recommendations = append(recommendations, &Recommendation{
			Priority:    RecommendationPriorityLow,
			Category:    "Performance",
			Title:       "Improve Validation Performance",
			Description: fmt.Sprintf("Validation took %v, which is longer than expected.", result.Duration),
			Actions: []string{
				"Consider using batch validation for large sequences",
				"Enable validation caching if available",
				"Review the number of validation rules enabled",
			},
		})
	}
	
	return recommendations
}

// Helper functions

func (r *ErrorReporter) findMostCommonRule(errors []*ValidationError) string {
	ruleCounts := make(map[string]int)
	for _, err := range errors {
		ruleCounts[err.RuleID]++
	}
	
	maxCount := 0
	mostCommon := ""
	for rule, count := range ruleCounts {
		if count > maxCount {
			maxCount = count
			mostCommon = rule
		}
	}
	
	return mostCommon
}

func (r *ErrorReporter) findRelatedEvents(err *ValidationError, context *ValidationContext) []Event {
	var related []Event
	
	if context.EventSequence == nil || err.EventID == "" {
		return related
	}
	
	// Find events with the same ID or related IDs
	for _, event := range context.EventSequence {
		if r.isRelatedEvent(event, err.EventID) {
			related = append(related, event)
		}
	}
	
	return related
}

func (r *ErrorReporter) findRelatedEventIDs(err *ValidationError, context *ValidationContext) []string {
	var relatedIDs []string
	
	if err.EventID == "" {
		return relatedIDs
	}
	
	// Find related IDs based on event type and relationships
	switch err.EventType {
	case EventTypeTextMessageContent:
		relatedIDs = append(relatedIDs, err.EventID+"-start", err.EventID+"-end")
	case EventTypeToolCallArgs:
		relatedIDs = append(relatedIDs, err.EventID+"-start", err.EventID+"-end")
	}
	
	return relatedIDs
}

func (r *ErrorReporter) isRelatedEvent(event Event, eventID string) bool {
	switch e := event.(type) {
	case *TextMessageStartEvent:
		return e.MessageID == eventID
	case *TextMessageContentEvent:
		return e.MessageID == eventID
	case *TextMessageEndEvent:
		return e.MessageID == eventID
	case *ToolCallStartEvent:
		return e.ToolCallID == eventID
	case *ToolCallArgsEvent:
		return e.ToolCallID == eventID
	case *ToolCallEndEvent:
		return e.ToolCallID == eventID
	case *RunStartedEvent:
		return e.RunID == eventID
	case *RunFinishedEvent:
		return e.RunID == eventID
	case *RunErrorEvent:
		return e.RunID == eventID
	}
	
	return false
}

func (r *ErrorReporter) isProtocolViolation(err *ValidationError) bool {
	protocolRules := []string{
		"RUN_LIFECYCLE",
		"EVENT_ORDERING",
		"MESSAGE_LIFECYCLE",
		"TOOL_CALL_LIFECYCLE",
	}
	
	for _, rule := range protocolRules {
		if err.RuleID == rule {
			return true
		}
	}
	
	return false
}

func (r *ErrorReporter) generateFixExamples(err *ValidationError) []*FixExample {
	var examples []*FixExample
	
	switch err.RuleID {
	case "MESSAGE_LIFECYCLE":
		examples = append(examples, &FixExample{
			Title:       "Proper Message Sequence",
			Description: "Send events in the correct order: start → content → end",
			Code: `// Correct sequence
startEvent := &TextMessageStartEvent{MessageID: "msg-123"}
contentEvent := &TextMessageContentEvent{MessageID: "msg-123", Delta: "Hello"}
endEvent := &TextMessageEndEvent{MessageID: "msg-123"}`,
		})
		
	case "TOOL_CALL_LIFECYCLE":
		examples = append(examples, &FixExample{
			Title:       "Proper Tool Call Sequence",
			Description: "Send events in the correct order: start → args → end",
			Code: `// Correct sequence
startEvent := &ToolCallStartEvent{ToolCallID: "tool-123", ToolCallName: "calculator"}
argsEvent := &ToolCallArgsEvent{ToolCallID: "tool-123", Delta: "2 + 2"}
endEvent := &ToolCallEndEvent{ToolCallID: "tool-123"}`,
		})
	}
	
	return examples
}

// FormatReport formats the error report for display
func (r *ErrorReporter) FormatReport(report *ErrorReport, format string) (string, error) {
	switch strings.ToLower(format) {
	case "json":
		data, err := json.MarshalIndent(report, "", "  ")
		return string(data), err
		
	case "text", "plain":
		return r.formatAsText(report), nil
		
	case "markdown", "md":
		return r.formatAsMarkdown(report), nil
		
	default:
		return "", fmt.Errorf("unsupported format: %s", format)
	}
}

// formatAsText formats the report as plain text
func (r *ErrorReporter) formatAsText(report *ErrorReport) string {
	var builder strings.Builder
	
	// Summary
	builder.WriteString(fmt.Sprintf("Event Validation Report - %s\n", report.Timestamp.Format(time.RFC3339)))
	builder.WriteString(strings.Repeat("=", 50) + "\n")
	builder.WriteString(fmt.Sprintf("Total Events: %d\n", report.Summary.TotalEvents))
	builder.WriteString(fmt.Sprintf("Errors: %d (%.2f%%)\n", report.Summary.TotalErrors, report.Summary.ErrorRate*100))
	builder.WriteString(fmt.Sprintf("Warnings: %d (%.2f%%)\n", report.Summary.TotalWarnings, report.Summary.WarningRate*100))
	builder.WriteString("\n")
	
	// Errors
	if len(report.Errors) > 0 {
		builder.WriteString("ERRORS:\n")
		builder.WriteString(strings.Repeat("-", 20) + "\n")
		for i, err := range report.Errors {
			builder.WriteString(fmt.Sprintf("%d. [%s] %s\n", i+1, err.RuleID, err.Message))
			if err.EventID != "" {
				builder.WriteString(fmt.Sprintf("   Event ID: %s\n", err.EventID))
			}
			builder.WriteString(fmt.Sprintf("   Event Type: %s\n", err.EventType))
			if len(err.Suggestions) > 0 {
				builder.WriteString("   Suggestions:\n")
				for _, suggestion := range err.Suggestions {
					builder.WriteString(fmt.Sprintf("   - %s\n", suggestion))
				}
			}
			builder.WriteString("\n")
		}
	}
	
	// Warnings
	if len(report.Warnings) > 0 {
		builder.WriteString("WARNINGS:\n")
		builder.WriteString(strings.Repeat("-", 20) + "\n")
		for i, warning := range report.Warnings {
			builder.WriteString(fmt.Sprintf("%d. [%s] %s\n", i+1, warning.RuleID, warning.Message))
			if warning.EventID != "" {
				builder.WriteString(fmt.Sprintf("   Event ID: %s\n", warning.EventID))
			}
			builder.WriteString("\n")
		}
	}
	
	// Recommendations
	if len(report.Recommendations) > 0 {
		builder.WriteString("RECOMMENDATIONS:\n")
		builder.WriteString(strings.Repeat("-", 20) + "\n")
		for i, rec := range report.Recommendations {
			builder.WriteString(fmt.Sprintf("%d. [%s] %s\n", i+1, rec.Priority, rec.Title))
			builder.WriteString(fmt.Sprintf("   %s\n", rec.Description))
			if len(rec.Actions) > 0 {
				builder.WriteString("   Actions:\n")
				for _, action := range rec.Actions {
					builder.WriteString(fmt.Sprintf("   - %s\n", action))
				}
			}
			builder.WriteString("\n")
		}
	}
	
	return builder.String()
}

// formatAsMarkdown formats the report as Markdown
func (r *ErrorReporter) formatAsMarkdown(report *ErrorReport) string {
	var builder strings.Builder
	
	// Title
	builder.WriteString(fmt.Sprintf("# Event Validation Report\n\n"))
	builder.WriteString(fmt.Sprintf("**Generated:** %s\n\n", report.Timestamp.Format(time.RFC3339)))
	
	// Summary
	builder.WriteString("## Summary\n\n")
	builder.WriteString(fmt.Sprintf("- **Total Events:** %d\n", report.Summary.TotalEvents))
	builder.WriteString(fmt.Sprintf("- **Errors:** %d (%.2f%%)\n", report.Summary.TotalErrors, report.Summary.ErrorRate*100))
	builder.WriteString(fmt.Sprintf("- **Warnings:** %d (%.2f%%)\n", report.Summary.TotalWarnings, report.Summary.WarningRate*100))
	builder.WriteString(fmt.Sprintf("- **Critical Errors:** %d\n\n", report.Summary.CriticalErrors))
	
	// Errors
	if len(report.Errors) > 0 {
		builder.WriteString("## Errors\n\n")
		for i, err := range report.Errors {
			builder.WriteString(fmt.Sprintf("### %d. %s\n\n", i+1, err.RuleID))
			builder.WriteString(fmt.Sprintf("**Message:** %s\n\n", err.Message))
			if err.EventID != "" {
				builder.WriteString(fmt.Sprintf("**Event ID:** `%s`\n\n", err.EventID))
			}
			builder.WriteString(fmt.Sprintf("**Event Type:** `%s`\n\n", err.EventType))
			
			if len(err.Suggestions) > 0 {
				builder.WriteString("**Suggestions:**\n")
				for _, suggestion := range err.Suggestions {
					builder.WriteString(fmt.Sprintf("- %s\n", suggestion))
				}
				builder.WriteString("\n")
			}
		}
	}
	
	// Warnings
	if len(report.Warnings) > 0 {
		builder.WriteString("## Warnings\n\n")
		for i, warning := range report.Warnings {
			builder.WriteString(fmt.Sprintf("### %d. %s\n\n", i+1, warning.RuleID))
			builder.WriteString(fmt.Sprintf("**Message:** %s\n\n", warning.Message))
			if warning.EventID != "" {
				builder.WriteString(fmt.Sprintf("**Event ID:** `%s`\n\n", warning.EventID))
			}
		}
	}
	
	// Recommendations
	if len(report.Recommendations) > 0 {
		builder.WriteString("## Recommendations\n\n")
		for i, rec := range report.Recommendations {
			builder.WriteString(fmt.Sprintf("### %d. %s (%s Priority)\n\n", i+1, rec.Title, rec.Priority))
			builder.WriteString(fmt.Sprintf("%s\n\n", rec.Description))
			
			if len(rec.Actions) > 0 {
				builder.WriteString("**Recommended Actions:**\n")
				for _, action := range rec.Actions {
					builder.WriteString(fmt.Sprintf("- %s\n", action))
				}
				builder.WriteString("\n")
			}
		}
	}
	
	return builder.String()
}

// Helper function for max
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}