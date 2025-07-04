package tools

import (
	"testing"
)

func TestParseSemverVersion(t *testing.T) {
	tests := []struct {
		name    string
		version string
		want    *semverVersion
		wantErr bool
	}{
		{
			name:    "valid version",
			version: "1.2.3",
			want:    &semverVersion{Major: 1, Minor: 2, Patch: 3},
		},
		{
			name:    "valid version with v prefix",
			version: "v2.0.0",
			want:    &semverVersion{Major: 2, Minor: 0, Patch: 0},
		},
		{
			name:    "invalid format - missing parts",
			version: "1.2",
			wantErr: true,
		},
		{
			name:    "invalid format - too many parts",
			version: "1.2.3.4",
			wantErr: true,
		},
		{
			name:    "invalid major version",
			version: "a.2.3",
			wantErr: true,
		},
		{
			name:    "invalid minor version",
			version: "1.b.3",
			wantErr: true,
		},
		{
			name:    "invalid patch version",
			version: "1.2.c",
			wantErr: true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSemverVersion(tt.version)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseSemverVersion() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && (got.Major != tt.want.Major || got.Minor != tt.want.Minor || got.Patch != tt.want.Patch) {
				t.Errorf("parseSemverVersion() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSemverVersionCompare(t *testing.T) {
	tests := []struct {
		name  string
		v1    *semverVersion
		v2    *semverVersion
		want  int
	}{
		{
			name: "equal versions",
			v1:   &semverVersion{1, 0, 0},
			v2:   &semverVersion{1, 0, 0},
			want: 0,
		},
		{
			name: "major version greater",
			v1:   &semverVersion{2, 0, 0},
			v2:   &semverVersion{1, 0, 0},
			want: 1,
		},
		{
			name: "major version less",
			v1:   &semverVersion{1, 0, 0},
			v2:   &semverVersion{2, 0, 0},
			want: -1,
		},
		{
			name: "minor version greater",
			v1:   &semverVersion{1, 2, 0},
			v2:   &semverVersion{1, 1, 0},
			want: 1,
		},
		{
			name: "patch version greater",
			v1:   &semverVersion{1, 0, 2},
			v2:   &semverVersion{1, 0, 1},
			want: 1,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.v1.compare(tt.v2); got != tt.want {
				t.Errorf("compare() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMatchesVersionConstraint(t *testing.T) {
	tests := []struct {
		name       string
		version    string
		constraint string
		want       bool
		wantErr    bool
	}{
		// Exact match
		{
			name:       "exact match - equal",
			version:    "1.0.0",
			constraint: "1.0.0",
			want:       true,
		},
		{
			name:       "exact match - not equal",
			version:    "1.0.1",
			constraint: "1.0.0",
			want:       false,
		},
		// Greater than or equal
		{
			name:       ">= constraint - equal",
			version:    "1.0.0",
			constraint: ">=1.0.0",
			want:       true,
		},
		{
			name:       ">= constraint - greater",
			version:    "1.1.0",
			constraint: ">=1.0.0",
			want:       true,
		},
		{
			name:       ">= constraint - less",
			version:    "0.9.0",
			constraint: ">=1.0.0",
			want:       false,
		},
		// Greater than
		{
			name:       "> constraint - greater",
			version:    "1.0.1",
			constraint: ">1.0.0",
			want:       true,
		},
		{
			name:       "> constraint - equal",
			version:    "1.0.0",
			constraint: ">1.0.0",
			want:       false,
		},
		// Less than or equal
		{
			name:       "<= constraint - less",
			version:    "0.9.0",
			constraint: "<=1.0.0",
			want:       true,
		},
		{
			name:       "<= constraint - equal",
			version:    "1.0.0",
			constraint: "<=1.0.0",
			want:       true,
		},
		{
			name:       "<= constraint - greater",
			version:    "1.0.1",
			constraint: "<=1.0.0",
			want:       false,
		},
		// Less than
		{
			name:       "< constraint - less",
			version:    "0.9.9",
			constraint: "<1.0.0",
			want:       true,
		},
		{
			name:       "< constraint - equal",
			version:    "1.0.0",
			constraint: "<1.0.0",
			want:       false,
		},
		// Caret (^) - compatible with major version
		{
			name:       "^ constraint - same major, higher minor",
			version:    "1.2.0",
			constraint: "^1.0.0",
			want:       true,
		},
		{
			name:       "^ constraint - different major",
			version:    "2.0.0",
			constraint: "^1.0.0",
			want:       false,
		},
		{
			name:       "^ constraint - lower version",
			version:    "0.9.0",
			constraint: "^1.0.0",
			want:       false,
		},
		// Tilde (~) - compatible with major.minor version
		{
			name:       "~ constraint - same major.minor, higher patch",
			version:    "1.0.5",
			constraint: "~1.0.0",
			want:       true,
		},
		{
			name:       "~ constraint - different minor",
			version:    "1.1.0",
			constraint: "~1.0.0",
			want:       false,
		},
		{
			name:       "~ constraint - lower patch",
			version:    "1.0.0",
			constraint: "~1.0.2",
			want:       false,
		},
		// Empty constraint
		{
			name:       "empty constraint",
			version:    "1.0.0",
			constraint: "",
			want:       true,
		},
		// Invalid versions
		{
			name:       "invalid version",
			version:    "invalid",
			constraint: ">=1.0.0",
			wantErr:    true,
		},
		{
			name:       "invalid constraint version",
			version:    "1.0.0",
			constraint: ">=invalid",
			wantErr:    true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := matchesVersionConstraint(tt.version, tt.constraint)
			if (err != nil) != tt.wantErr {
				t.Errorf("matchesVersionConstraint() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("matchesVersionConstraint() = %v, want %v", got, tt.want)
			}
		})
	}
}