package runstore

import (
	"sync"
	"testing"
	"time"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/cloudwego/eino/schema"
)

func testSaved(content string) *Saved {
	return &Saved{
		Messages:     []*schema.Message{schema.UserMessage(content)},
		WireMessages: []aguitypes.Message{{ID: "wire-1", Role: aguitypes.RoleUser, Content: content}},
		Pending: []schema.ToolCall{{
			ID:       "c1",
			Function: schema.FunctionCall{Name: "file_read", Arguments: `{}`},
		}},
		State: map[string]any{"status": "awaiting_approval"},
	}
}

func TestWireMessagesHaveIndependentSaveAndLoadOwnership(t *testing.T) {
	s := New()
	saved := testSaved("hi")
	source := &aguitypes.InputContentSource{Type: "data", Value: "original"}
	metadata := map[string]any{"nested": []any{map[string]any{"value": "original"}}}
	saved.WireMessages[0].Content = []aguitypes.InputContent{{Type: "image", Source: source, Metadata: metadata}}
	s.Save("k", saved)
	saved.WireMessages[0].ID = "caller-mutated"
	source.Value = "caller-mutated"
	metadata["nested"].([]any)[0].(map[string]any)["value"] = "caller-mutated"

	first, _ := s.Load("k")
	if first.WireMessages[0].ID != "wire-1" {
		t.Fatalf("save aliased caller wire transcript: %q", first.WireMessages[0].ID)
	}
	firstPart := first.WireMessages[0].Content.([]aguitypes.InputContent)[0]
	if firstPart.Source.Value != "original" || firstPart.Metadata.(map[string]any)["nested"].([]any)[0].(map[string]any)["value"] != "original" {
		t.Fatalf("save aliased nested wire content: %#v", firstPart)
	}
	first.WireMessages[0].ID = "load-mutated"
	firstPart.Source.Value = "load-mutated"
	firstPart.Metadata.(map[string]any)["nested"].([]any)[0].(map[string]any)["value"] = "load-mutated"
	second, _ := s.Load("k")
	if second.WireMessages[0].ID != "wire-1" {
		t.Fatalf("load exposed stored wire transcript: %q", second.WireMessages[0].ID)
	}
	secondPart := second.WireMessages[0].Content.([]aguitypes.InputContent)[0]
	if secondPart.Source.Value != "original" || secondPart.Metadata.(map[string]any)["nested"].([]any)[0].(map[string]any)["value"] != "original" {
		t.Fatalf("load exposed nested stored content: %#v", secondPart)
	}
}

func TestSaveLoad(t *testing.T) {
	s := New()
	s.Save("k", testSaved("hi"))

	got, ok := s.Load("k")
	if !ok {
		t.Fatal("expected a hit")
	}
	if len(got.Messages) != 1 || got.Messages[0].Content != "hi" {
		t.Fatalf("unexpected saved messages: %+v", got.Messages)
	}
}

func TestLoadExpiredIsMissAndDeletes(t *testing.T) {
	now := time.Unix(0, 0)
	s := New()
	s.now = func() time.Time { return now }

	s.Save("k", testSaved("hi"))
	now = now.Add(s.ttl + time.Second) // advance past the TTL

	if _, ok := s.Load("k"); ok {
		t.Fatal("expected an expired miss")
	}
	s.mu.Lock()
	_, present := s.m["k"]
	s.mu.Unlock()
	if present {
		t.Fatal("expired entry should be deleted in-line on Load")
	}
}

func TestLoadAndDeleteClaimsOnce(t *testing.T) {
	s := New()
	s.Save("k", testSaved("hi"))

	if _, ok := s.LoadAndDelete("k"); !ok {
		t.Fatal("first claim should hit")
	}
	if _, ok := s.LoadAndDelete("k"); ok {
		t.Fatal("second claim should miss (entry already claimed)")
	}
}

func TestLoadAndDeleteExpired(t *testing.T) {
	now := time.Unix(0, 0)
	s := New()
	s.now = func() time.Time { return now }

	s.Save("k", testSaved("hi"))
	now = now.Add(s.ttl + time.Second)

	if _, ok := s.LoadAndDelete("k"); ok {
		t.Fatal("expired LoadAndDelete should miss")
	}
}

func TestEvictOldestOnOverflow(t *testing.T) {
	now := time.Unix(0, 0)
	s := New()
	s.now = func() time.Time { return now }
	s.maxEntries = 2

	s.Save("a", testSaved("a"))
	now = now.Add(time.Second)
	s.Save("b", testSaved("b"))
	now = now.Add(time.Second)
	s.Save("c", testSaved("c")) // at capacity → evicts the oldest ("a")

	if _, ok := s.Load("a"); ok {
		t.Error("oldest entry 'a' should have been evicted")
	}
	if _, ok := s.Load("b"); !ok {
		t.Error("'b' should remain")
	}
	if _, ok := s.Load("c"); !ok {
		t.Error("'c' should remain")
	}
}

func TestResaveExistingKeyDoesNotEvict(t *testing.T) {
	now := time.Unix(0, 0)
	s := New()
	s.now = func() time.Time { return now }
	s.maxEntries = 2

	s.Save("a", testSaved("a"))
	now = now.Add(time.Second)
	s.Save("b", testSaved("b"))
	now = now.Add(time.Second)
	s.Save("a", testSaved("a2")) // re-saving an existing key must not evict 'b'

	if _, ok := s.Load("b"); !ok {
		t.Error("'b' should not be evicted when re-saving existing key 'a'")
	}
	got, ok := s.Load("a")
	if !ok || got.Messages[0].Content != "a2" {
		t.Error("'a' should be updated to 'a2'")
	}
}

func TestSaveCopiesSlices(t *testing.T) {
	s := New()
	saved := testSaved("hi")
	s.Save("k", saved)

	// Mutating the caller's slices after Save must not reach the stored run.
	saved.Pending[0].Function.Name = "MUTATED"
	saved.Messages[0] = schema.UserMessage("MUTATED")

	got, _ := s.Load("k")
	if got.Pending[0].Function.Name != "file_read" {
		t.Errorf("stored Pending aliased the caller slice: %q", got.Pending[0].Function.Name)
	}
	if got.Messages[0].Content != "hi" {
		t.Errorf("stored Messages aliased the caller slice: %q", got.Messages[0].Content)
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := New()
	s.maxEntries = 8

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := Key("thread", string(rune('a'+i%8)))
			s.Save(key, testSaved("x"))
			s.Load(key)
			s.LoadAndDelete(key)
			s.Delete(key)
		}(i)
	}
	wg.Wait()
}
