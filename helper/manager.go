package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type boundedLog struct {
	mu   sync.Mutex
	data []byte
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	const limit = 8192
	if len(p) >= limit {
		b.data = append(b.data[:0], p[len(p)-limit:]...)
	} else {
		b.data = append(b.data, p...)
		if len(b.data) > limit {
			b.data = append([]byte(nil), b.data[len(b.data)-limit:]...)
		}
	}
	return n, nil
}
func (b *boundedLog) text() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.ToLower(string(b.data))
}
func classify(log *boundedLog, fallback string) *apiError {
	s := log.text()
	switch {
	case strings.Contains(s, "host key verification failed"), strings.Contains(s, "remote host identification has changed"), strings.Contains(s, "no ed25519 host key is known"), strings.Contains(s, "no rsa host key is known"), strings.Contains(s, "no ecdsa host key is known"):
		return failure("HOST_KEY", "SSH host key is unknown or changed. Verify it outside the browser.")
	case strings.Contains(s, "permission denied"), strings.Contains(s, "authentication failed"), strings.Contains(s, "sign_and_send_pubkey"), strings.Contains(s, "load key"):
		return failure("AUTH", "SSH key or agent authentication failed. Interactive authentication is not supported.")
	case strings.Contains(s, "timed out"), strings.Contains(s, "timeout"):
		return failure("TIMEOUT", "SSH connection timed out.")
	case strings.Contains(s, "connection refused"), strings.Contains(s, "no route to host"), strings.Contains(s, "could not resolve hostname"), strings.Contains(s, "network is unreachable"), strings.Contains(s, "connection reset"), strings.Contains(s, "connection closed by"):
		return failure("NETWORK", "SSH server is unreachable.")
	default:
		return failure(fallback, "SSH tunnel could not be established.")
	}
}

type childProcess interface {
	Wait() error
	Stop()
}
type commandRunner func(args []string, stderr io.Writer) (childProcess, error)
type realChild struct {
	cmd  *exec.Cmd
	once sync.Once
}

func (c *realChild) Wait() error { return c.cmd.Wait() }
func (c *realChild) Stop() {
	c.once.Do(func() {
		// Own a process group, including ProxyJump and ProxyCommand descendants.
		_ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGTERM)
		time.Sleep(100 * time.Millisecond)
		_ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL)
	})
}
func runSSH(args []string, stderr io.Writer) (childProcess, error) {
	cmd := exec.Command("/usr/bin/ssh", args...)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 500 * time.Millisecond
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &realChild{cmd: cmd}, nil
}

type tunnelInfo struct {
	TunnelID string `json:"tunnelId"`
	HostID   string `json:"hostId"`
	Port     int    `json:"port"`
	Status   string `json:"status"`
	// ConnectMs covers process start through SOCKS readiness, including port-collision retries.
	ConnectMs int64 `json:"connectMs"`
}
type tunnel struct {
	info        tunnelInfo
	process     childProcess
	log         *boundedLog
	done        chan struct{}
	intentional bool
	exitErr     error
}
type exitEvent struct {
	Event    string `json:"event"`
	TunnelID string `json:"tunnelId"`
	HostID   string `json:"hostId"`
	Reason   string `json:"reason"`
	Code     int    `json:"code"`
}
type tunnelManager struct {
	mu               sync.Mutex
	tunnels          map[string]*tunnel
	runner           commandRunner
	emit             func(exitEvent)
	readinessTimeout time.Duration
	closing          bool
	closeOnce        sync.Once
}

func newManager(runner commandRunner, emit func(exitEvent)) *tunnelManager {
	return &tunnelManager{tunnels: make(map[string]*tunnel), runner: runner, emit: emit, readinessTimeout: 15 * time.Second}
}
func freePort() (int, error) {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	p := l.Addr().(*net.TCPAddr).Port
	err = l.Close()
	return p, err
}
func newID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(id[:]), nil
}
func (m *tunnelManager) watch(t *tunnel) {
	err := t.process.Wait()
	t.process.Stop() // Reap the owned group before publishing completion or removing it.
	m.mu.Lock()
	t.exitErr = err
	unexpected := !t.intentional && t.info.Status == "ready" && !m.closing
	delete(m.tunnels, t.info.TunnelID)
	close(t.done)
	m.mu.Unlock()
	if unexpected && m.emit != nil {
		code := 0
		if err != nil {
			code = -1
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			}
		}
		m.emit(exitEvent{Event: "tunnel-exit", TunnelID: t.info.TunnelID, HostID: t.info.HostID, Reason: classify(t.log, "SSH_EXIT").Code, Code: code})
	}
}
func (m *tunnelManager) connect(ctx context.Context, h hostSpec) (tunnelInfo, *apiError) {
	if ctx.Err() != nil {
		return tunnelInfo{}, failure("CANCELLED", "SSH connection was cancelled.")
	}
	if err := validateHost(h); err != nil {
		return tunnelInfo{}, err
	}
	started := time.Now()
	deadlineCtx, cancel := context.WithTimeout(ctx, m.readinessTimeout)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		port, err := freePort()
		if err != nil {
			return tunnelInfo{}, failure("LOCAL_PORT", "No local forwarding port is available.")
		}
		args, _ := sshArgs(h, port)
		id, err := newID()
		if err != nil {
			return tunnelInfo{}, failure("INTERNAL", "Cannot create tunnel identifier.")
		}
		t := &tunnel{info: tunnelInfo{TunnelID: id, HostID: h.ID, Port: port, Status: "connecting"}, log: &boundedLog{}, done: make(chan struct{})}
		m.mu.Lock()
		if m.closing || deadlineCtx.Err() != nil {
			m.mu.Unlock()
			return tunnelInfo{}, failure("CANCELLED", "SSH connection was cancelled.")
		}
		if len(m.tunnels) >= 2 {
			m.mu.Unlock()
			return tunnelInfo{}, failure("TUNNEL_LIMIT", "At most two SSH tunnels can run at once.")
		}
		process, err := m.runner(args, t.log)
		if err != nil {
			m.mu.Unlock()
			return tunnelInfo{}, failure("SSH_START", "Could not start the system SSH client.")
		}
		t.process = process
		m.tunnels[id] = t
		m.mu.Unlock()
		go m.watch(t)
		err = waitSOCKS(deadlineCtx, t)
		if err == nil {
			m.mu.Lock()
			if current, exists := m.tunnels[id]; exists && current == t && !m.closing && deadlineCtx.Err() == nil {
				t.info.Status = "ready"
				t.info.ConnectMs = time.Since(started).Milliseconds()
				info := t.info
				m.mu.Unlock()
				return info, nil
			}
			m.mu.Unlock()
			err = errors.New("SSH exited")
		}
		collision := strings.Contains(t.log.text(), "address already in use")
		m.release(id)
		if collision && attempt < 2 && deadlineCtx.Err() == nil {
			continue
		}
		if errors.Is(deadlineCtx.Err(), context.Canceled) {
			return tunnelInfo{}, failure("CANCELLED", "SSH connection was cancelled.")
		}
		fallback := "SSH_CONNECT"
		if deadlineCtx.Err() != nil {
			fallback = "TIMEOUT"
		}
		result := classify(t.log, fallback)
		if fallback == "TIMEOUT" && result.Code == "TIMEOUT" {
			result.Message = "SSH tunnel was not ready within the connection deadline."
		}
		return tunnelInfo{}, result
	}
	return tunnelInfo{}, failure("LOCAL_PORT", "Could not allocate a local forwarding port.")
}
func waitSOCKS(ctx context.Context, t *tunnel) error {
	address := net.JoinHostPort("127.0.0.1", itoa(t.info.Port))
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.done:
			return errors.New("SSH exited")
		default:
		}
		dialer := net.Dialer{Timeout: 200 * time.Millisecond}
		conn, err := dialer.DialContext(ctx, "tcp4", address)
		if err == nil {
			deadline := time.Now().Add(300 * time.Millisecond)
			if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
				deadline = d
			}
			_ = conn.SetDeadline(deadline)
			_, err = conn.Write([]byte{5, 1, 0})
			if err == nil {
				var reply [2]byte
				_, err = io.ReadFull(conn, reply[:])
				if err == nil && !bytes.Equal(reply[:], []byte{5, 0}) {
					err = errors.New("invalid SOCKS reply")
				}
			}
			_ = conn.Close()
			if err == nil {
				select {
				case <-t.done:
					return errors.New("SSH exited")
				default:
					return nil
				}
			}
		}
		timer := time.NewTimer(80 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-t.done:
			timer.Stop()
			return errors.New("SSH exited")
		case <-timer.C:
		}
	}
}
func itoa(n int) string { // The port is a positive 16-bit value.
	if n == 0 {
		return "0"
	}
	var a [20]byte
	i := len(a)
	for n > 0 {
		i--
		a[i] = byte('0' + n%10)
		n /= 10
	}
	return string(a[i:])
}
func (m *tunnelManager) release(id string) {
	m.mu.Lock()
	t := m.tunnels[id]
	if t != nil {
		t.intentional = true
	}
	m.mu.Unlock()
	if t != nil {
		t.process.Stop()
		select {
		case <-t.done:
		case <-time.After(time.Second):
		}
	}
}
func (m *tunnelManager) disconnect() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.tunnels))
	for id, t := range m.tunnels {
		t.intentional = true
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.release(id)
	}
}
func (m *tunnelManager) close() {
	m.closeOnce.Do(func() { m.mu.Lock(); m.closing = true; m.mu.Unlock(); m.disconnect() })
}
func (m *tunnelManager) status() []tunnelInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]tunnelInfo, 0, len(m.tunnels))
	for _, t := range m.tunnels {
		out = append(out, t.info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TunnelID < out[j].TunnelID })
	return out
}
