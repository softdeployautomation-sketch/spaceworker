// Command relay is the work-PC egress relay (directive §13): an HTTP(S)
// CONNECT proxy that the hosted clone's browser uses as --proxy-server so
// every request egresses from the work PC's public IP and carried sessions
// stay valid.
//
// TWO LISTEN PATHS (TASK_118 B8-3):
//
//  1. --addr: the classic listener, loopback-bound in production, token-gated
//     via Proxy-Authorization. Kept for lab/topology use AND as the install
//     script's port preflight.
//  2. --tunnel: DIAL-OUT mode. The relay connects out to our ingress and
//     serves proxy requests over those outbound conns (see tunnel.go). This is
//     the production path: the hosted clone browser lives on our server and
//     could never reach a loopback listener, and the old "replayed over the
//     Mesh tunnel" comment described something that was never implemented —
//     no TCP tunnel exists in either repo. Dialling out also means the work PC
//     needs no inbound port, no firewall rule and no router change.
//
// Authentication: --token gates the --addr listener via
// Proxy-Authorization: Bearer <token> and authenticates the --tunnel control
// handshake. Tunnelled conns are NOT proxy-token-checked: they are admitted
// only by the ingress after that handshake, and the browser side is gated by
// the ingress' per-job routing credential — so the token is never widened,
// it is just enforced once, at the boundary that can actually enforce it.
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

var hopHeaders = []string{
	"Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection",
	"Connection", "Keep-Alive", "Te", "Trailer", "Transfer-Encoding",
	"Upgrade",
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8118", "listen address (loopback in production)")
	token := flag.String("token", "", "require Proxy-Authorization: Bearer <token> (and gate --tunnel)")
	tunnelHost := flag.String("tunnel", "", "dial-out ingress host:port (empty = listener mode only)")
	tunnelKey := flag.String("tunnel-key", "", "device routing key the ingress pairs browser conns to")
	flag.Parse()

	// Bind BEFORE anything else: a stale relay (or receiver) squatting the
	// endpoint otherwise fails opaquely - the windowsgui build has no console,
	// so silence == confusion. This bind is also the port preflight the
	// install scripts rely on: a non-zero exit means the endpoint was taken.
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Printf("relay: cannot bind %s (already in use?): %v", *addr, err)
		log.SetOutput(io.Discard) // windowsgui build: keep the exit clean
		os.Exit(1)
	}

	// Tunnelled conns skip the proxy bearer check: the ingress already admitted
	// them via the control handshake and gates the browser side per job (see the
	// package comment). The --addr listener keeps its own token.
	if *tunnelHost != "" {
		if *tunnelKey == "" {
			log.Print("relay: -tunnel requires -tunnel-key (the ingress cannot route streams without it)")
			log.SetOutput(io.Discard)
			os.Exit(1)
		}
		t := newTunnel(*tunnelHost, *token, *tunnelKey)
		go t.run()
		tsrv := &http.Server{
			Handler:           &relay{},
			ReadHeaderTimeout: 15 * time.Second,
		}
		go func() {
			// ErrClosed on shutdown is expected, not a fault.
			if err := tsrv.Serve(t.ln); err != nil && err != net.ErrClosed {
				log.Printf("relay: tunnel server stopped: %v", err)
			}
		}()
		log.Printf("relay: dial-out tunnel enabled -> %s (key %q)", *tunnelHost, *tunnelKey)
	}

	srv := &http.Server{
		Handler:           &relay{token: *token},
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("egress relay (directive §13) listening on %s", *addr)
	log.Fatal(srv.Serve(ln)) // Serve(ln) keeps the preflight bind (no re-bind race)
}

type relay struct{ token string }

// authorized enforces the optional bearer token ([IP relay auth]).
func (r *relay) authorized(req *http.Request) bool {
	if r.token == "" {
		return true
	}
	return req.Header.Get("Proxy-Authorization") == "Bearer "+r.token
}

func (r *relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if !r.authorized(req) {
		w.Header().Set("Proxy-Authenticate", `Bearer realm="egress-relay"`)
		w.WriteHeader(407)
		return
	}
	if req.Method == http.MethodConnect {
		r.tunnel(w, req)
		return
	}
	// Plain-HTTP absolute-form request: forward via Transport, which dials
	// req.URL (the origin), then relay the response.
	tr := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return dialCtx(ctx, addr)
	}}
	out := req.Clone(req.Context())
	out.RequestURI = ""
	out.Header.Del("Proxy-Authorization")
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	resp, err := tr.RoundTrip(out)
	if err != nil {
		http.Error(w, "relay: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	w.WriteHeader(resp.StatusCode)
	copyHeader(w.Header(), resp.Header)
	io.Copy(w, resp.Body)
}

// dialCtx dials IPv4 first (VMs behind NAT64-less libvirt networks often
// resolve AAAA-first but have no v6 route; the v6 attempt blackholes),
// falling back to dual-stack for v6-only targets.
func dialCtx(ctx context.Context, dst string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 7 * time.Second}
	c, err := d.DialContext(ctx, "tcp4", dst)
	if err == nil {
		return c, nil
	}
	log.Printf("relay: tcp4 dial %s failed (%v), trying dual-stack", dst, err)
	c, err = d.DialContext(ctx, "tcp", dst)
	if err != nil {
		log.Printf("relay: dial %s failed: %v", dst, err)
	}
	return c, err
}

// tunnel handles CONNECT: dial the origin, reply 200, then splice bytes.
func (r *relay) tunnel(w http.ResponseWriter, req *http.Request) {
	dst := req.Host
	if _, _, err := net.SplitHostPort(dst); err != nil {
		dst = net.JoinHostPort(dst, "443")
	}
	target, err := dialCtx(req.Context(), dst)
	if err != nil {
		http.Error(w, "relay: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer target.Close()

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "relay: connection hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		http.Error(w, "relay: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(target, brw.Reader); target.Close(); done <- struct{}{} }()
	go func() { io.Copy(conn, target); conn.Close(); done <- struct{}{} }()
	<-done
	<-done
}

func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}
