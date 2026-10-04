package main

import (
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type hostSpec struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Group    string `json:"group"`
	Favorite bool   `json:"favorite"`
	Mode     string `json:"mode"`
	Alias    string `json:"alias"`
	Address  string `json:"address"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	KeyPath  string `json:"keyPath"`
}

var aliasPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$`)
var addressPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$`)
var userPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\$?$`)
var originPattern = regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`)

func validateOrigin(args []string) error {
	// Chrome may append platform-owned launch arguments after the caller origin.
	if len(args) > 0 && !originPattern.MatchString(args[0]) {
		return fmt.Errorf("invalid caller origin")
	}
	return nil
}
func validateHost(h hostSpec) *apiError {
	bad := func() *apiError { return failure("INVALID_HOST", "Invalid SSH host settings.") }
	if !validID(h.ID) {
		return bad()
	}
	switch h.Mode {
	case "alias":
		if !aliasPattern.MatchString(h.Alias) {
			return bad()
		}
	case "manual":
		if net.ParseIP(h.Address) == nil && !addressPattern.MatchString(h.Address) {
			return bad()
		}
		if h.User != "" && !userPattern.MatchString(h.User) {
			return bad()
		}
		if h.Port < 0 || h.Port > 65535 {
			return bad()
		}
		if h.KeyPath != "" {
			if !filepath.IsAbs(h.KeyPath) || len(h.KeyPath) > 4096 {
				return bad()
			}
			for _, r := range h.KeyPath {
				if unicode.IsControl(r) {
					return bad()
				}
			}
		}
	default:
		return bad()
	}
	return nil
}
func sshArgs(h hostSpec, port int) ([]string, *apiError) {
	if err := validateHost(h); err != nil {
		return nil, err
	}
	args := []string{"-N", "-T", "-S", "none", "-D", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), "-o", "ControlMaster=no", "-o", "ControlPersist=no", "-o", "ForkAfterAuthentication=no", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"}
	dest := h.Alias
	if h.Mode == "manual" {
		dest = h.Address
		port := h.Port
		if port == 0 {
			port = 22
		}
		args = append(args, "-p", strconv.Itoa(port))
		if h.User != "" {
			args = append(args, "-l", h.User)
		}
		if h.KeyPath != "" {
			args = append(args, "-i", h.KeyPath)
		}
	}
	// All untrusted values are separate arguments; never evaluated by a shell.
	return append(args, "--", strings.TrimSpace(dest)), nil
}
