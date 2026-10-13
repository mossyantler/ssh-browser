package main

import (
	"context"
	"io"
	"net"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"
)

// networkEvent tells the extension when usable connectivity appears, disappears or moves.
type networkEvent struct {
	Event  string `json:"event"`
	Online bool   `json:"online"`
}

// networkWatch is replaced in tests so protocol frames stay deterministic.
var networkWatch = func(ctx context.Context, emit func(networkEvent)) {
	source, err := openRouteSocket()
	if err != nil {
		return // Reconnect still works on its fixed backoff without change hints.
	}
	watchNetwork(ctx, source, interfaceSnapshot, 500*time.Millisecond, emit)
}

// openRouteSocket uses the BSD routing socket, which needs no cgo or entitlements.
func openRouteSocket() (io.ReadCloser, error) {
	fd, err := syscall.Socket(syscall.AF_ROUTE, syscall.SOCK_RAW, syscall.AF_UNSPEC)
	if err != nil {
		return nil, err
	}
	// Nonblocking descriptors join the runtime poller, so Close interrupts a pending Read.
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "route"), nil
}

// routeChange reports whether a routing message can alter reachability or local addresses.
func routeChange(message []byte) bool {
	for len(message) >= 4 {
		size := int(message[0]) | int(message[1])<<8
		if size < 4 || size > len(message) {
			return false
		}
		switch message[3] {
		case syscall.RTM_IFINFO, syscall.RTM_NEWADDR, syscall.RTM_DELADDR, syscall.RTM_ADD, syscall.RTM_DELETE:
			return true
		}
		message = message[size:]
	}
	return false
}

// interfaceSnapshot is online when an up, non-loopback interface has a routable address.
// Link-local addresses exist on idle interfaces (awdl, llw), so they do not count.
func interfaceSnapshot() (bool, string) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return false, ""
	}
	var addresses []string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			prefix, ok := addr.(*net.IPNet)
			if !ok || !prefix.IP.IsGlobalUnicast() {
				continue
			}
			addresses = append(addresses, iface.Name+"="+prefix.IP.String())
		}
	}
	sort.Strings(addresses)
	return len(addresses) > 0, strings.Join(addresses, ",")
}

// watchNetwork emits the initial state, then one event per settled change in
// online state or address set. Bursts of routing messages collapse into one check.
func watchNetwork(ctx context.Context, source io.ReadCloser, snapshot func() (bool, string), debounce time.Duration, emit func(networkEvent)) {
	defer source.Close()
	changes := make(chan struct{}, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		buffer := make([]byte, 4096)
		for {
			n, err := source.Read(buffer)
			if err != nil {
				return
			}
			if routeChange(buffer[:n]) {
				select {
				case changes <- struct{}{}:
				default:
				}
			}
		}
	}()
	online, fingerprint := snapshot()
	emit(networkEvent{Event: "network-change", Online: online})
	timer := time.NewTimer(debounce)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-readerDone:
			return
		case <-changes:
			timer.Reset(debounce)
		case <-timer.C:
			nextOnline, nextFingerprint := snapshot()
			if nextOnline != online || nextFingerprint != fingerprint {
				online, fingerprint = nextOnline, nextFingerprint
				emit(networkEvent{Event: "network-change", Online: online})
			}
		}
	}
}
