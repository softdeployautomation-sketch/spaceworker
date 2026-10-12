// Command swfwd is the loopback forwarder the hosted clone browser needs so the
// SpaceWorker app can speak CDP to it (TASK_119A A4).
//
// WHY IT MUST EXIST: Chromium's DevTools HTTP/WebSocket endpoint binds
// CONTAINER loopback only and --remote-debugging-address=0.0.0.0 is ignored, so
// Docker's published port cannot reach it (TASK_117 F5, measured). The forwarder
// is started inside the session container (bind-mounted in and run by
// supervisord, see browser-server/chromium-session-config.ts) and listens on the
// container's own interfaces; browser-server publishes that port with
// `-p 127.0.0.1:<host port>:<container port>`, so the endpoint is reachable by
// browser-server and by NOTHING ELSE. The published port is never 0.0.0.0: the
// CDP endpoint grants full control of the browser, including its cookies.
//
// It is a raw TCP pump, not a proxy: no HTTP parsing, no rewriting, no
// buffering policy of its own. WebSocket upgrades, the /json/version handshake
// and every CDP frame flow through byte-for-byte, which is exactly what the
// dependency-free client in lib/cdp.ts expects.
//
// SAFETY: the target must be a LOOPBACK address. A forwarder that accepted an
// arbitrary target would turn an exposed port into an open proxy into the
// container network, so a non-loopback -target is refused at startup rather
// than warned about.
//
// Usage (inside the container):
//
//	swfwd -listen 0.0.0.0:9223 -target 127.0.0.1:9222
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// Defaults match browser-server/chromium-session-config.ts. They are only
// defaults: the launch conf passes both explicitly so the two sides can never
// drift apart silently.
const (
	defaultListen = "0.0.0.0:9223"
	defaultTarget = "127.0.0.1:9222"
)

// dialTimeout bounds the connect to DevTools. Chromium opens the port at the
// very end of startup, so a fresh container can genuinely refuse for a moment;
// a connection is retried by the client (lib/cdp.ts's own per-request timeout),
// not held open here.
const dialTimeout = 5 * time.Second

// loopbackHosts are the only targets this forwarder will ever dial.
var loopbackHosts = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
	"localhost": true,
}

// validateTarget refuses anything that is not loopback. Exported behaviour is
// tested in main_test.go — this is a security boundary, not a convenience check.
func validateTarget(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid -target %q: %w", addr, err)
	}
	if port == "" {
		return fmt.Errorf("invalid -target %q: missing port", addr)
	}
	if !loopbackHosts[strings.ToLower(host)] {
		// A literal loopback IP that is not in the map (e.g. "127.0.0.2") is
		// still loopback; anything else is not.
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return fmt.Errorf("refusing non-loopback -target %q: DevTools may only be reached in-container", addr)
		}
	}
	return nil
}

// forward accepts connections on ln and pumps each one to target until ctx is
// cancelled. It returns the accept error that ended the loop (nil on shutdown).
func forward(ctx context.Context, ln net.Listener, target string) error {
	var live int64
	var conns int64

	go func() {
		<-ctx.Done()
		// Unblocks Accept so the process can exit cleanly on SIGTERM.
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		n := atomic.AddInt64(&conns, 1)
		now := atomic.AddInt64(&live, 1)
		// Counts only — never a cookie, never a URL, never a header. This log
		// line is the forwarder's entire output surface.
		log.Printf("swfwd: conn #%d open (live=%d)", n, now)
		go func() {
			defer func() {
				log.Printf("swfwd: conn #%d closed (live=%d)", n, atomic.AddInt64(&live, -1))
			}()
			pump(conn, target)
		}()
	}
}

// pump wires one accepted connection to one dialled target and copies in both
// directions until either side closes.
func pump(client net.Conn, target string) {
	defer client.Close()
	upstream, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		// The client (lib/cdp.ts) reports its own named timeout; this line only
		// says the dial failed, with no payload from either side.
		log.Printf("swfwd: dial %s failed: %v", target, err)
		return
	}
	defer upstream.Close()

	done := make(chan struct{}, 2)
	copyBoth := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(*net.TCPConn); ok {
			_ = c.CloseWrite() // half-close: the peer must still be able to reply
		}
		done <- struct{}{}
	}
	go copyBoth(upstream, client)
	go copyBoth(client, upstream)
	<-done
	<-done
}

func main() {
	listen := flag.String("listen", defaultListen, "address to listen on inside the container (0.0.0.0 so a published port can reach it)")
	target := flag.String("target", defaultTarget, "DevTools address to forward to (loopback only)")
	flag.Parse()

	if err := validateTarget(*target); err != nil {
		fmt.Fprintln(os.Stderr, "swfwd:", err)
		os.Exit(2)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "swfwd: listen failed:", err)
		os.Exit(1)
	}
	// One line, on stdout, and nothing else: the conf redirects it to
	// /var/log/neko/swfwd.log so a launch can be diagnosed from the container.
	log.SetFlags(0)
	log.SetOutput(os.Stdout)
	log.Printf("swfwd: listening on %s -> %s", ln.Addr().String(), *target)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := forward(ctx, ln, *target); err != nil {
		log.Printf("swfwd: accept failed: %v", err)
		os.Exit(1)
	}
	log.Printf("swfwd: stopped")
}
