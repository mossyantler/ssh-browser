package main

import (
	"strings"
	"testing"
)

func TestSSHArgsControlledOptions(t *testing.T) {
	for _, tc := range []struct {
		name string
		host hostSpec
		dest string
		port string
	}{
		{"alias", hostSpec{ID: "h", Mode: "alias", Alias: "oracle"}, "oracle", ""},
		{"manual defaults", hostSpec{ID: "h", Mode: "manual", Address: "example.test"}, "example.test", "22"},
		{"manual IPv6 and literal key", hostSpec{ID: "h", Mode: "manual", Address: "2001:db8::1", Port: 2222, User: "alice", KeyPath: "/tmp/key with spaces;$(id)"}, "2001:db8::1", "2222"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args, err := sshArgs(tc.host, 12345)
			if err != nil {
				t.Fatal(err)
			}
			boundary, boundaries := -1, 0
			for i, arg := range args {
				if arg == "--" {
					boundary = i
					boundaries++
				}
			}
			if boundaries != 1 || boundary != len(args)-2 || args[boundary+1] != tc.dest {
				t.Fatalf("destination must be the sole argument after --: %q", args)
			}
			options := make(map[string][]string)
			flags := make(map[string][]string)
			for i := 0; i < boundary; i++ {
				switch args[i] {
				case "-N", "-T":
					flags[args[i]] = append(flags[args[i]], "")
				case "-o", "-S", "-D", "-p", "-l", "-i":
					flag := args[i]
					if i+1 >= boundary {
						t.Fatalf("missing value for %s before --", flag)
					}
					i++
					if flag == "-o" {
						key, value, ok := strings.Cut(args[i], "=")
						if !ok {
							t.Fatalf("invalid SSH option %q", args[i])
						}
						key = strings.ToLower(key)
						options[key] = append(options[key], value)
					} else {
						flags[flag] = append(flags[flag], args[i])
					}
				default:
					t.Fatalf("unexpected standalone argument before --: %q", args[i])
				}
			}
			// Assert policy properties rather than mirroring the entire argv order.
			for option, want := range map[string]string{
				"updatehostkeys": "no", "checkhostip": "no",
				"permitlocalcommand": "no", "addkeystoagent": "no",
				"stricthostkeychecking": "yes", "batchmode": "yes",
				"controlmaster": "no", "controlpersist": "no",
				"forkafterauthentication": "no", "exitonforwardfailure": "yes",
			} {
				values := options[option]
				if len(values) != 1 || values[0] != want {
					t.Errorf("%s must occur once before -- with value %s; got %q", option, want, values)
				}
			}
			for flag, want := range map[string]string{"-N": "", "-T": "", "-S": "none", "-D": "127.0.0.1:12345"} {
				values := flags[flag]
				if len(values) != 1 || values[0] != want {
					t.Errorf("%s: got %q, want one %q", flag, values, want)
				}
			}
			for flag, want := range map[string]string{"-p": tc.port, "-l": tc.host.User, "-i": tc.host.KeyPath} {
				values := flags[flag]
				if want == "" {
					if len(values) != 0 {
						t.Errorf("unexpected %s: %q", flag, values)
					}
				} else if len(values) != 1 || values[0] != want {
					t.Errorf("%s must preserve its value as one argument: got %q, want %q", flag, values, want)
				}
			}
		})
	}
}

func TestSSHArgsInvalidHostReturnsNoArgs(t *testing.T) {
	for _, tc := range []struct {
		name string
		host hostSpec
	}{
		{"invalid ID", hostSpec{Mode: "alias", Alias: "oracle"}},
		{"unknown mode", hostSpec{ID: "h", Mode: "unknown"}},
		{"alias option injection", hostSpec{ID: "h", Mode: "alias", Alias: "-oProxyCommand=id"}},
		{"alias shell injection", hostSpec{ID: "h", Mode: "alias", Alias: "oracle;id"}},
		{"address option injection", hostSpec{ID: "h", Mode: "manual", Address: "-oProxyCommand=id"}},
		{"user injection", hostSpec{ID: "h", Mode: "manual", Address: "example.test", User: "alice -oProxyCommand=id"}},
		{"negative port", hostSpec{ID: "h", Mode: "manual", Address: "example.test", Port: -1}},
		{"oversized port", hostSpec{ID: "h", Mode: "manual", Address: "example.test", Port: 65536}},
		{"relative key", hostSpec{ID: "h", Mode: "manual", Address: "example.test", KeyPath: "key"}},
		{"key control character", hostSpec{ID: "h", Mode: "manual", Address: "example.test", KeyPath: "/tmp/key\n"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args, err := sshArgs(tc.host, 12345)
			if err == nil || err.Code != "INVALID_HOST" || args != nil {
				t.Fatalf("invalid host must return INVALID_HOST and no args: args=%q, err=%v", args, err)
			}
		})
	}
}
