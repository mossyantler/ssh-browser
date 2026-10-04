package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func serve(ctx context.Context, input io.Reader, output io.Writer, runner commandRunner) error {
	writer := &protocolWriter{w: output}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	manager := newManager(runner, func(e exitEvent) {
		if err := writer.send(e); err != nil {
			cancel()
		}
	})
	defer manager.close()
	go func() { <-ctx.Done(); manager.close() }()
	type incoming struct {
		data []byte
		err  error
	}
	frames := make(chan incoming)
	finished := make(chan struct{})
	defer close(finished)
	// Read independently so EOF or malformed framing also cancels a pending connect.
	go func() {
		for {
			data, err := readFrame(input)
			if err != nil {
				cancel()
			}
			select {
			case frames <- incoming{data, err}:
			case <-finished:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	hello := false
	for {
		frame := <-frames
		if frame.err != nil {
			return frame.err
		}
		data := frame.data
		r, err := decodeRequest(data)
		if err != nil {
			return err
		} // Malformed protocol fails closed.
		reply := response{RequestID: r.RequestID, OK: true}
		if !hello && r.Command != "hello" {
			reply.OK = false
			reply.Error = failure("HELLO_REQUIRED", "Send hello with protocol 1 and profileId first.")
		} else {
			switch r.Command {
			case "hello":
				if r.Protocol != 1 || !validID(r.ProfileID) {
					reply.Error = failure("PROTOCOL", "Protocol 1 and a valid profileId are required.")
				} else if hello {
					reply.Error = failure("ALREADY_INITIALIZED", "This native connection is already initialized.")
				} else {
					hello = true
					reply.Result = map[string]any{"version": version, "protocol": 1}
				}
			case "connect":
				reply.Result, reply.Error = manager.connect(ctx, r.Host)
			case "release":
				if !validID(r.TunnelID) {
					reply.Error = failure("INVALID_TUNNEL", "Invalid tunnel identifier.")
				} else {
					manager.release(r.TunnelID)
					reply.Result = map[string]bool{"released": true}
				}
			case "disconnect":
				manager.disconnect()
				reply.Result = map[string]bool{"disconnected": true}
			case "status":
				reply.Result = map[string]any{"tunnels": manager.status()}
			default:
				reply.Error = failure("UNKNOWN_COMMAND", "Unknown native command.")
			}
			if reply.Error != nil {
				reply.OK = false
				reply.Result = nil
			}
		}
		if err := writer.send(reply); err != nil {
			return err
		}
	}
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	if validateOrigin(os.Args[1:]) != nil {
		fmt.Fprintln(os.Stderr, "Invalid native messaging caller origin.")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	// Interrupt blocking stdin on signal, so cleanup never waits for another frame.
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	if err := serve(ctx, os.Stdin, os.Stdout, runSSH); err != nil && err != io.EOF && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "Native messaging session ended: invalid or unavailable input/output.")
		os.Exit(1)
	}
}
