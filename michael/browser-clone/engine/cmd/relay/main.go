// Command relay is the work-PC egress relay (directive §13): an HTTP(S)
// CONNECT proxy that the hosted clone's browser uses as --proxy-server so
// every request egresses from the work PC's public IP and carried sessions
// stay valid. Loopback-bound in production (replayed over the Mesh tunnel);
// --addr allows other bindings for lab/topology setups.
//
// Authentication: --token enables Proxy-Authorization: Bearer <token>
// enforcement; without it the relay is open on its bind address (lab use).
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
	token := flag.String("token", "", "require Proxy-Authorization: Bearer <token>")
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
