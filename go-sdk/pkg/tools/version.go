package tools

import (
	"fmt"
	"strconv"
	"strings"
)

// semverVersion represents a parsed semantic version
type semverVersion struct {
	Major int
	Minor int
	Patch int
}

// parseSemverVersion parses a semantic version string like "1.2.3"
func parseSemverVersion(version string) (*semverVersion, error) {
	// Remove 'v' prefix if present
	version = strings.TrimPrefix(version, "v")
	
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid version format %q: expected major.minor.patch", version)
	}
	
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid major version %q: %w", parts[0], err)
	}
	
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid minor version %q: %w", parts[1], err)
	}
	
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		return nil, fmt.Errorf("invalid patch version %q: %w", parts[2], err)
	}
	
	return &semverVersion{
		Major: major,
		Minor: minor,
		Patch: patch,
	}, nil
}

// compare returns -1 if v < other, 0 if v == other, 1 if v > other
func (v *semverVersion) compare(other *semverVersion) int {
	if v.Major != other.Major {
		if v.Major < other.Major {
			return -1
		}
		return 1
	}
	
	if v.Minor != other.Minor {
		if v.Minor < other.Minor {
			return -1
		}
		return 1
	}
	
	if v.Patch != other.Patch {
		if v.Patch < other.Patch {
			return -1
		}
		return 1
	}
	
	return 0
}

// matchesVersionConstraint checks if a version matches a constraint
// Supports constraints like:
// - "1.0.0" (exact match)
// - ">=1.0.0" (greater than or equal)
// - ">1.0.0" (greater than)
// - "<=1.0.0" (less than or equal)
// - "<1.0.0" (less than)
// - "^1.0.0" (compatible with 1.x.x)
// - "~1.0.0" (compatible with 1.0.x)
func matchesVersionConstraint(version, constraint string) (bool, error) {
	if constraint == "" {
		return true, nil
	}
	
	// Parse the operator and version from constraint
	var op string
	var constraintVersion string
	
	if strings.HasPrefix(constraint, ">=") {
		op = ">="
		constraintVersion = constraint[2:]
	} else if strings.HasPrefix(constraint, "<=") {
		op = "<="
		constraintVersion = constraint[2:]
	} else if strings.HasPrefix(constraint, ">") {
		op = ">"
		constraintVersion = constraint[1:]
	} else if strings.HasPrefix(constraint, "<") {
		op = "<"
		constraintVersion = constraint[1:]
	} else if strings.HasPrefix(constraint, "^") {
		op = "^"
		constraintVersion = constraint[1:]
	} else if strings.HasPrefix(constraint, "~") {
		op = "~"
		constraintVersion = constraint[1:]
	} else {
		// Exact match
		op = "="
		constraintVersion = constraint
	}
	
	// Parse versions
	v, err := parseSemverVersion(version)
	if err != nil {
		return false, fmt.Errorf("invalid version: %w", err)
	}
	
	cv, err := parseSemverVersion(constraintVersion)
	if err != nil {
		return false, fmt.Errorf("invalid constraint version: %w", err)
	}
	
	// Apply the constraint
	switch op {
	case "=":
		return v.compare(cv) == 0, nil
	case ">=":
		return v.compare(cv) >= 0, nil
	case ">":
		return v.compare(cv) > 0, nil
	case "<=":
		return v.compare(cv) <= 0, nil
	case "<":
		return v.compare(cv) < 0, nil
	case "^":
		// Compatible with same major version
		if v.Major != cv.Major {
			return false, nil
		}
		return v.compare(cv) >= 0, nil
	case "~":
		// Compatible with same major.minor version
		if v.Major != cv.Major || v.Minor != cv.Minor {
			return false, nil
		}
		return v.compare(cv) >= 0, nil
	default:
		return false, fmt.Errorf("unknown version constraint operator %q", op)
	}
}