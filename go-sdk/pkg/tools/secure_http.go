package tools

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"golang.org/x/net/idna"
)

// SecureHTTPOptions defines security options for HTTP operations
type SecureHTTPOptions struct {
	// AllowedHosts defines hosts that are allowed for HTTP requests
	// If empty, all hosts are allowed except those in DenyHosts
	AllowedHosts []string
	
	// DenyHosts defines hosts that are explicitly denied
	// Takes precedence over AllowedHosts
	DenyHosts []string
	
	// AllowPrivateNetworks determines if requests to private IP ranges are allowed
	AllowPrivateNetworks bool
	
	// AllowedSchemes defines allowed URL schemes (default: https, http)
	AllowedSchemes []string
	
	// MaxRedirects defines the maximum number of redirects to follow
	MaxRedirects int
}

// DefaultSecureHTTPOptions returns secure default options
func DefaultSecureHTTPOptions() *SecureHTTPOptions {
	return &SecureHTTPOptions{
		AllowPrivateNetworks: false,
		AllowedSchemes:       []string{"http", "https"},
		MaxRedirects:         5,
		DenyHosts: []string{
			"metadata.google.internal",
			"169.254.169.254", // AWS metadata
			"metadata.azure.com",
		},
	}
}

// SecureHTTPExecutor wraps HTTP operations with security checks
type SecureHTTPExecutor struct {
	options  *SecureHTTPOptions
	executor ToolExecutor
}

// NewSecureHTTPExecutor creates a new secure HTTP executor
func NewSecureHTTPExecutor(executor ToolExecutor, options *SecureHTTPOptions) *SecureHTTPExecutor {
	if options == nil {
		options = DefaultSecureHTTPOptions()
	}
	return &SecureHTTPExecutor{
		options:  options,
		executor: executor,
	}
}

// Execute performs the HTTP operation with security checks
func (e *SecureHTTPExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	// Extract URL from params
	urlStr, ok := params["url"].(string)
	if !ok {
		return nil, fmt.Errorf("url parameter is required")
	}
	
	// Validate URL
	if err := e.validateURL(urlStr); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("URL validation failed: %v", err),
		}, nil
	}
	
	// Execute the underlying operation
	return e.executor.Execute(ctx, params)
}

// validateURL checks if the URL is allowed based on security options
func (e *SecureHTTPExecutor) validateURL(urlStr string) error {
	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("invalid URL format: %w", err)
	}
	
	// Check scheme
	if !e.isSchemeAllowed(parsedURL.Scheme) {
		return fmt.Errorf("scheme %q is not allowed", parsedURL.Scheme)
	}
	
	// Extract hostname
	hostname := parsedURL.Hostname()
	if hostname == "" {
		return fmt.Errorf("URL must have a valid hostname")
	}
	
	// Check deny list first
	for _, denyHost := range e.options.DenyHosts {
		if strings.EqualFold(hostname, denyHost) {
			return fmt.Errorf("host %q is explicitly denied", hostname)
		}
	}
	
	// Check if it's an IP address
	if ip := net.ParseIP(hostname); ip != nil {
		if err := e.validateIPAddress(ip); err != nil {
			return err
		}
	} else {
		// It's a hostname, resolve it to check the IP
		if err := e.validateHostname(hostname); err != nil {
			return err
		}
	}
	
	// Check allowed hosts if specified
	if len(e.options.AllowedHosts) > 0 {
		allowed := false
		normalizedHostname := e.normalizeHostname(hostname)
		for _, allowedHost := range e.options.AllowedHosts {
			normalizedAllowed := e.normalizeHostname(allowedHost)
			if normalizedHostname == normalizedAllowed || 
			   strings.HasSuffix(normalizedHostname, "."+normalizedAllowed) {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("host %q is not in allowed hosts list", hostname)
		}
	}
	
	return nil
}

// isSchemeAllowed checks if the URL scheme is allowed
func (e *SecureHTTPExecutor) isSchemeAllowed(scheme string) bool {
	for _, allowed := range e.options.AllowedSchemes {
		if strings.EqualFold(scheme, allowed) {
			return true
		}
	}
	return false
}

// validateIPAddress checks if an IP address is allowed
func (e *SecureHTTPExecutor) validateIPAddress(ip net.IP) error {
	if !e.options.AllowPrivateNetworks {
		if isPrivateIP(ip) {
			return fmt.Errorf("requests to private IP addresses are not allowed")
		}
		if ip.IsLoopback() {
			return fmt.Errorf("requests to loopback addresses are not allowed")
		}
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("requests to link-local addresses are not allowed")
		}
	}
	return nil
}

// validateHostname resolves and validates a hostname
func (e *SecureHTTPExecutor) validateHostname(hostname string) error {
	// Resolve hostname to IP addresses
	ips, err := net.LookupIP(hostname)
	if err != nil {
		return fmt.Errorf("cannot resolve hostname: %w", err)
	}
	
	// Check each resolved IP
	for _, ip := range ips {
		if err := e.validateIPAddress(ip); err != nil {
			return fmt.Errorf("hostname %q resolves to restricted IP: %w", hostname, err)
		}
	}
	
	return nil
}

// isPrivateIP checks if an IP is in a private range
func isPrivateIP(ip net.IP) bool {
	privateRanges := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"fc00::/7",
		"fe80::/10",
	}
	
	for _, cidr := range privateRanges {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	
	return false
}

// normalizeHostname normalizes a hostname to prevent bypass attacks
func (e *SecureHTTPExecutor) normalizeHostname(hostname string) string {
	// Convert to lowercase
	hostname = strings.ToLower(hostname)
	
	// Handle internationalized domain names (IDN)
	normalized, err := idna.ToASCII(hostname)
	if err != nil {
		// If IDN conversion fails, return the lowercase original
		return hostname
	}
	
	return normalized
}

// NewSecureHTTPGetTool creates a secure HTTP GET tool
func NewSecureHTTPGetTool(options *SecureHTTPOptions) *Tool {
	baseTool := NewHTTPGetTool()
	baseTool.Executor = NewSecureHTTPExecutor(&httpGetExecutor{}, options)
	return baseTool
}

// NewSecureHTTPPostTool creates a secure HTTP POST tool
func NewSecureHTTPPostTool(options *SecureHTTPOptions) *Tool {
	baseTool := NewHTTPPostTool()
	baseTool.Executor = NewSecureHTTPExecutor(&httpPostExecutor{}, options)
	return baseTool
}