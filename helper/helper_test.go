package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFraming(t *testing.T) {
	var b bytes.Buffer
	w := protocolWriter{w: &b}
	value := map[string]any{"requestId": "abc", "ok": true}
	if err := w.send(value); err != nil {
		t.Fatal(err)
	}
	data, err := readFrame(&b)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err = json.Unmarshal(data, &result); err != nil || !reflect.DeepEqual(result, value) {
		t.Fatalf("roundtrip %v %v", result, err)
	}
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"short header", []byte{1, 0}}, {"short payload", append(frameHeader(10), []byte("{}")...)},
		{"oversize", frameHeader(maxFrame + 1)}, {"zero", frameHeader(0)}, {"UTF8", append(frameHeader(1), 255)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := readFrame(bytes.NewReader(test.data)); err == nil {
				t.Fatal("accepted malformed frame")
			}
		})
	}
	if _, err := readFrame(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("EOF %v", err)
	}
}
func frameHeader(size uint32) []byte {
	b := make([]byte, 4)
	binary.NativeEndian.PutUint32(b, size)
	return b
}
func TestValidation(t *testing.T) {
	for _, alias := range []string{"-oProxyCommand=id", "host;id", "x$(id)", "x\ny", "x y", "user@host", "a/b"} {
		if validateHost(hostSpec{ID: "h", Mode: "alias", Alias: alias}) == nil {
			t.Errorf("accepted alias %q", alias)
		}
	}
	for _, address := range []string{"-x", "host;id", "user@host", "foo bar", "$(id)", "[::1]"} {
		if validateHost(hostSpec{ID: "h", Mode: "manual", Address: address}) == nil {
			t.Errorf("accepted address %q", address)
		}
	}
	for _, key := range []string{"relative", "~/key", "/key\x00", "/key\n"} {
		if validateHost(hostSpec{ID: "h", Mode: "manual", Address: "host", KeyPath: key}) == nil {
			t.Errorf("accepted key %q", key)
		}
	}
	h := hostSpec{ID: "host-1", Mode: "manual", Address: "2001:db8::1", Port: 2222, User: "alice", KeyPath: "/Users/alice/.ssh/key with spaces"}
	args, err := sshArgs(h, 12345)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"-N", "-T", "-S", "none", "-D", "127.0.0.1:12345", "-o", "ControlMaster=no", "-o", "ControlPersist=no", "-o", "ForkAfterAuthentication=no", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-p", "2222", "-l", "alice", "-i", "/Users/alice/.ssh/key with spaces", "--", "2001:db8::1"}
	if !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected args: %v", args)
	}
	for _, origin := range []string{"https://example.com/", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {
		if validateOrigin([]string{origin}) == nil {
			t.Errorf("accepted origin %q", origin)
		}
	}
	if validateOrigin([]string{"chrome-extension://abcdefghijklmnopabcdefghijklmnop/"}) != nil {
		t.Fatal("valid origin rejected")
	}
	if validateOrigin(nil) != nil {
		t.Fatal("no origin rejected")
	}
	for _, id := range []string{"", strings.Repeat("a", 129), "a\n", "a b"} {
		if validID(id) {
			t.Errorf("accepted id %q", id)
		}
	}
}

type fakeChild struct {
	done     chan struct{}
	once     sync.Once
	listener net.Listener
	err      error
}

func (f *fakeChild) Wait() error { <-f.done; return f.err }
func (f *fakeChild) Stop() {
	f.once.Do(func() {
		if f.listener != nil {
			_ = f.listener.Close()
		}
		close(f.done)
	})
}
func fakeRunner(ready bool, capture chan *fakeChild) commandRunner {
	return func(args []string, stderr io.Writer) (childProcess, error) {
		child := &fakeChild{done: make(chan struct{})}
		if ready {
			address := ""
			for i, arg := range args {
				if arg == "-D" {
					address = args[i+1]
				}
			}
			listener, err := net.Listen("tcp4", address)
			if err != nil {
				return nil, err
			}
			child.listener = listener
			go func() {
				for {
					conn, err := listener.Accept()
					if err != nil {
						return
					}
					go func() {
						defer conn.Close()
						_ = conn.SetDeadline(time.Now().Add(time.Second))
						var greeting [3]byte
						if _, err := io.ReadFull(conn, greeting[:]); err == nil && greeting == [3]byte{5, 1, 0} {
							_, _ = conn.Write([]byte{5, 0})
						}
					}()
				}
			}()
		}
		if capture != nil {
			capture <- child
		}
		return child, nil
	}
}
func TestManagerSwitchAndRelease(t *testing.T) {
	events := make(chan exitEvent, 4)
	m := newManager(fakeRunner(true, nil), func(e exitEvent) { events <- e })
	defer m.close()
	h := hostSpec{ID: "h", Mode: "alias", Alias: "my-server"}
	a, err := m.connect(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.connect(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	if a.TunnelID == b.TunnelID || len(m.status()) != 2 {
		t.Fatal("switch did not preserve old tunnel")
	}
	if _, err := m.connect(context.Background(), h); err == nil || err.Code != "TUNNEL_LIMIT" {
		t.Fatalf("limit: %v", err)
	}
	m.release(a.TunnelID)
	if len(m.status()) != 1 {
		t.Fatal("release failed")
	}
	m.disconnect()
	if len(m.status()) != 0 {
		t.Fatal("disconnect failed")
	}
	select {
	case e := <-events:
		t.Fatalf("intentional event: %v", e)
	case <-time.After(30 * time.Millisecond):
	}
}
func TestManagerUnexpectedExit(t *testing.T) {
	children := make(chan *fakeChild, 1)
	events := make(chan exitEvent, 1)
	m := newManager(fakeRunner(true, children), func(e exitEvent) { events <- e })
	defer m.close()
	info, err := m.connect(context.Background(), hostSpec{ID: "h", Mode: "alias", Alias: "server"})
	if err != nil {
		t.Fatal(err)
	}
	child := <-children
	child.Stop()
	select {
	case e := <-events:
		if e.TunnelID != info.TunnelID || e.Event != "tunnel-exit" {
			t.Fatalf("bad event %v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("missing exit event")
	}
	if len(m.status()) != 0 {
		t.Fatal("dead tunnel retained")
	}
}
func TestReadinessTimeoutCleanup(t *testing.T) {
	children := make(chan *fakeChild, 1)
	m := newManager(fakeRunner(false, children), nil)
	m.readinessTimeout = 100 * time.Millisecond
	defer m.close()
	_, err := m.connect(context.Background(), hostSpec{ID: "h", Mode: "alias", Alias: "server"})
	if err == nil || err.Code != "TIMEOUT" {
		t.Fatalf("timeout: %v", err)
	}
	child := <-children
	select {
	case <-child.done:
	default:
		t.Fatal("failed tunnel not stopped")
	}
	if len(m.status()) != 0 {
		t.Fatal("failed tunnel retained")
	}
}
func TestCollisionRetries(t *testing.T) {
	count := 0
	runner := func(args []string, w io.Writer) (childProcess, error) {
		count++
		if count < 3 {
			_, _ = io.WriteString(w, "bind: Address already in use")
			f := &fakeChild{done: make(chan struct{}), err: errors.New("exit")}
			f.Stop()
			return f, nil
		}
		return fakeRunner(true, nil)(args, w)
	}
	m := newManager(runner, nil)
	defer m.close()
	if _, err := m.connect(context.Background(), hostSpec{ID: "h", Mode: "alias", Alias: "server"}); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("attempts %d", count)
	}
}
func TestBoundedDiagnostics(t *testing.T) {
	b := &boundedLog{}
	_, _ = b.Write(bytes.Repeat([]byte("s"), 1000000))
	if len(b.text()) != 8192 {
		t.Fatal("unbounded stderr")
	}
	for _, tc := range []struct{ message, code string }{{"Permission denied (publickey). secret", "AUTH"}, {"Host key verification failed. secret", "HOST_KEY"}, {"Connection timed out secret", "TIMEOUT"}} {
		b := &boundedLog{}
		_, _ = io.WriteString(b, tc.message)
		err := classify(b, "SSH_CONNECT")
		if err.Code != tc.code || strings.Contains(err.Message, "secret") {
			t.Fatalf("unsafe classification %v", err)
		}
	}
}
func TestHelloAndEOF(t *testing.T) {
	var input, output bytes.Buffer
	w := protocolWriter{w: &input}
	for _, r := range []any{map[string]any{"type": "status", "requestId": "1"}, map[string]any{"type": "hello", "requestId": "2", "protocol": 1, "profileId": "profile"}, map[string]any{"type": "status", "requestId": "3"}} {
		if err := w.send(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := serve(context.Background(), &input, &output, fakeRunner(true, nil)); err != io.EOF {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		b, err := readFrame(&output)
		if err != nil {
			t.Fatal(err)
		}
		var r response
		if err = json.Unmarshal(b, &r); err != nil {
			t.Fatal(err)
		}
		if i == 0 && (r.OK || r.Error.Code != "HELLO_REQUIRED") {
			t.Fatalf("handshake bypass %s", b)
		}
		if i > 0 && !r.OK {
			t.Fatalf("request failed %s", b)
		}
	}
}

func TestEOFCancelsPendingConnect(t *testing.T) {
	input, sender := io.Pipe()
	children := make(chan *fakeChild, 1)
	var output bytes.Buffer
	finished := make(chan error, 1)
	go func() { finished <- serve(context.Background(), input, &output, fakeRunner(false, children)) }()
	writer := &protocolWriter{w: sender}
	if err := writer.send(map[string]any{"type": "hello", "requestId": "1", "protocol": 1, "profileId": "profile"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.send(map[string]any{"type": "connect", "requestId": "2", "host": hostSpec{ID: "h", Mode: "alias", Alias: "server"}}); err != nil {
		t.Fatal(err)
	}
	var child *fakeChild
	select {
	case child = <-children:
	case <-time.After(time.Second):
		t.Fatal("connect not started")
	}
	_ = sender.Close()
	select {
	case err := <-finished:
		if err != io.EOF {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("EOF did not interrupt readiness")
	}
	select {
	case <-child.done:
	default:
		t.Fatal("EOF left SSH running")
	}
}

func TestCancelledConnectDoesNotLaunch(t *testing.T) {
	launched := false
	m := newManager(func(args []string, stderr io.Writer) (childProcess, error) {
		launched = true
		return nil, errors.New("must not launch")
	}, nil)
	defer m.close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.connect(ctx, hostSpec{ID: "h", Mode: "alias", Alias: "test-server"}); err == nil || err.Code != "CANCELLED" {
		t.Fatalf("cancelled result: %v", err)
	}
	if launched {
		t.Fatal("cancelled connect started SSH")
	}
}
