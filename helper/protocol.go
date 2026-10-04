package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"unicode/utf8"
)

const maxFrame = 256 * 1024
const version = "0.1.0"

func readFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	size := binary.NativeEndian.Uint32(header[:])
	if size == 0 || size > maxFrame {
		return nil, errors.New("invalid frame size")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, errors.New("invalid UTF-8")
	}
	return data, nil
}

type protocolWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *protocolWriter) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > maxFrame {
		return errors.New("outbound frame too large")
	}
	var header [4]byte
	binary.NativeEndian.PutUint32(header[:], uint32(len(data)))
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, b := range [][]byte{header[:], data} {
		for len(b) > 0 {
			n, err := w.w.Write(b)
			if err != nil {
				return err
			}
			if n <= 0 {
				return io.ErrShortWrite
			}
			b = b[n:]
		}
	}
	return nil
}

type request struct {
	Command   string   `json:"type"`
	RequestID string   `json:"requestId"`
	Protocol  int      `json:"protocol"`
	ProfileID string   `json:"profileId"`
	Host      hostSpec `json:"host"`
	TunnelID  string   `json:"tunnelId"`
}
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string            { return e.Message }
func failure(code, message string) *apiError { return &apiError{code, message} }

type response struct {
	RequestID string    `json:"requestId"`
	OK        bool      `json:"ok"`
	Result    any       `json:"result,omitempty"`
	Error     *apiError `json:"error,omitempty"`
}

func validID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}
func decodeRequest(data []byte) (request, error) {
	var r request
	if err := json.Unmarshal(data, &r); err != nil {
		return r, errors.New("invalid JSON request")
	}
	if !validID(r.RequestID) {
		return r, errors.New("invalid request ID")
	}
	if r.Command == "" {
		return r, fmt.Errorf("missing command")
	}
	return r, nil
}
