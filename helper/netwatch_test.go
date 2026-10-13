package main

import (
	"context"
	"io"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Protocol tests read frames in order; the real watcher would interleave events.
func init() { networkWatch = func(context.Context, func(networkEvent)) {} }

type fakeRoute struct {
	messages chan []byte
	once     sync.Once
	closed   chan struct{}
}

func newFakeRoute() *fakeRoute {
	return &fakeRoute{messages: make(chan []byte, 16), closed: make(chan struct{})}
}
func (f *fakeRoute) Read(p []byte) (int, error) {
	select {
	case m := <-f.messages:
		return copy(p, m), nil
	case <-f.closed:
		return 0, io.EOF
	}
}
func (f *fakeRoute) Close() error { f.once.Do(func() { close(f.closed) }); return nil }

func routeMessage(kind byte) []byte { return []byte{8, 0, 5, kind, 0, 0, 0, 0} }

func TestRouteChangeFiltersMessageTypes(t *testing.T) {
	if !routeChange(routeMessage(syscall.RTM_NEWADDR)) || !routeChange(append(routeMessage(syscall.RTM_GET), routeMessage(syscall.RTM_IFINFO)...)) {
		t.Fatal("relevant routing message ignored")
	}
	if routeChange(routeMessage(syscall.RTM_GET)) || routeChange([]byte{2, 0, 5}) || routeChange([]byte{200, 0, 5, syscall.RTM_ADD}) {
		t.Fatal("irrelevant or malformed routing message accepted")
	}
}

func TestWatchNetworkDebouncesAndReportsChanges(t *testing.T) {
	var mu sync.Mutex
	online, fingerprint, checks := true, "en0=192.0.2.1", 0
	snapshot := func() (bool, string) { mu.Lock(); defer mu.Unlock(); checks++; return online, fingerprint }
	events := make(chan networkEvent, 8)
	source := newFakeRoute()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchNetwork(ctx, source, snapshot, 20*time.Millisecond, func(e networkEvent) { events <- e })
		close(done)
	}()
	expect := func(want bool) {
		t.Helper()
		select {
		case e := <-events:
			if e.Event != "network-change" || e.Online != want {
				t.Fatalf("event %+v, want online=%v", e, want)
			}
		case <-time.After(time.Second):
			t.Fatal("missing network event")
		}
	}
	expect(true) // Initial state.
	mu.Lock()
	online, fingerprint = false, ""
	mu.Unlock()
	for i := 0; i < 5; i++ {
		source.messages <- routeMessage(syscall.RTM_DELADDR)
	}
	expect(false)
	mu.Lock()
	burstChecks := checks
	mu.Unlock()
	if burstChecks != 2 {
		t.Fatalf("burst was not debounced: %d snapshots", burstChecks)
	}
	source.messages <- routeMessage(syscall.RTM_ADD) // No state change: no event.
	mu.Lock()
	online, fingerprint = true, "en1=198.51.100.7"
	mu.Unlock()
	source.messages <- routeMessage(syscall.RTM_NEWADDR)
	expect(true)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("watcher did not stop on cancellation")
	}
	select {
	case <-source.closed:
	default:
		t.Fatal("route source left open")
	}
}

func TestInterfaceSnapshotIgnoresLoopback(t *testing.T) {
	_, fingerprint := interfaceSnapshot()
	for _, bad := range []string{"=127.", "=::1", "=fe80:"} {
		if strings.Contains(fingerprint, bad) {
			t.Fatalf("non-routable address in fingerprint %q", fingerprint)
		}
	}
}
