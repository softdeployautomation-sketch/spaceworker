package main

import (
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// TestForwardRoundTrip is the forwarder's core promise: bytes in one end come
// out the other, unmodified, and the connection stays open for a reply — which
// is what a WebSocket upgrade and every CDP frame need.
func TestForwardRoundTrip(t *testing.T) {
	// A stand-in for Chromium's DevTools socket: echoes one line back.
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("target listen: %v", err)
	}
	defer target.Close()
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("echo:"), buf[:n]...))
			}(c)
		}
	}()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("forward listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- forward(ctx, ln, target.Addr().String()) }()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("GET /json/version\n")); err != nil {
		t.Fatalf("write through forwarder: %v", err)
	}
	buf := make([]byte, 64)
	n, err := conn.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatalf("read through forwarder: %v", err)
	}
	if got := string(buf[:n]); got != "echo:GET /json/version\n" {
		t.Fatalf("payload not passed through byte-for-byte: %q", got)
	}

	// Cancelling is how SIGTERM reaches it; the accept loop must return nil
	// rather than treating its own closed listener as an error.
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("forward returned error on shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forward did not return after context cancel")
	}
}

// TestValidateTargetRefusesNonLoopback is the security boundary: an exposed
// forwarder must never be able to dial anywhere but the container's own
// DevTools port.
func TestValidateTargetRefusesNonLoopback(t *testing.T) {
	ok := []string{"127.0.0.1:9222", "localhost:9222", "[::1]:9222"}
	for _, addr := range ok {
		if err := validateTarget(addr); err != nil {
			t.Errorf("validateTarget(%q) = %v, want nil", addr, err)
		}
	}
	bad := []string{
		"0.0.0.0:9222",
		"172.17.0.1:9222",
		"example.com:9222",
		"93.184.216.34:9222",
		"127.0.0.1", // no port
		"",
	}
	for _, addr := range bad {
		if err := validateTarget(addr); err == nil {
			t.Errorf("validateTarget(%q) = nil, want refusal", addr)
		} else if !strings.Contains(err.Error(), "target") {
			t.Errorf("validateTarget(%q) error %v should name the target", addr, err)
		}
	}
}
