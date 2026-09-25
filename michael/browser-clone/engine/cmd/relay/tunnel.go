package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// Dial-out tunnel client (TASK_118 B8-3).
//
// The relay proper binds 127.0.0.1 in production (see main.go's doc comment),
// which our hosted clone browser cannot reach — the old "replayed over the Mesh
// tunnel" note was never implemented; no TCP tunnel exists in either repo, so
// the browser simply had no path to the work PC. Rather than requiring an
// inbound port (firewall rule + router change on a customer machine), the relay
// DIALS OUT to our ingress and serves proxy requests over those outbound conns.
//
// Wire protocol (one line of ASCII, then raw proxied bytes):
//
//	control : SWRELAY/1 <token> <key>\n          -> ingress replies "OK\n"
//	data    : SWRELAY/1 <token> <key> DATA <id>\n -> ingress splices it
//	ingress -> control: "NEW <id>\n"  (one per proxied connection)
//	ingress -> control: "PING\n"      (device answers "PONG\n")
//
// Control carries only stream setup, so it stays open and cheap; every proxied
// connection gets its OWN outbound TCP conn ("dial on demand"), which is why no
// multiplexing is needed — the ingress never has to frame HTTP inside a shared
// socket.
const (
	tunnelProto   = "SWRELAY/1"
	tunnelDialTO  = 10 * time.Second
	tunnelBackoff = 3 * time.Second
	// A data conn that the ingress does not claim within this window is
	// dropped rather than queued forever (a browser that gave up).
	tunnelStreamTO = 5 * time.Second
)

// connListener adapts a channel of already-dialled conns into a net.Listener so
// the existing http.Server + relay handler serve tunnelled conns unchanged.
// Ordering needs no preservation: each conn is an independent HTTP connection.
type connListener struct {
	conns chan net.Conn
	addr  net.Addr
	done  chan struct{}
	once  sync.Once
}

func (l *connListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *connListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *connListener) Addr() net.Addr { return l.addr }

// tunnelAddr labels the pseudo-listener in logs ("tunnel:host:port").
type tunnelAddr string

func (a tunnelAddr) Network() string { return "tunnel" }
func (a tunnelAddr) String() string  { return string(a) }

type tunnel struct {
	host  string // ingress host:port to dial
	token string // shared ingress secret
	key   string // device routing key (which work PC this relay serves)
	ln    *connListener
}

func newTunnel(host, token, key string) *tunnel {
	return &tunnel{
		host:  host,
		token: token,
		key:   key,
		ln: &connListener{
			conns: make(chan net.Conn, 32),
			addr:  tunnelAddr("tunnel:" + host),
			done:  make(chan struct{}),
		},
	}
}

// run keeps a control conn up, reconnecting forever with a fixed backoff.
// Losing control never kills already-spliced data conns — a browsing session
// survives a control blip; only NEW streams wait for the reconnect.
func (t *tunnel) run() {
	for {
		if err := t.control(); err != nil {
			select {
			case <-t.ln.done:
				return
			default:
			}
			log.Printf("relay: tunnel control to %s lost: %v (retry in %s)", t.host, err, tunnelBackoff)
		}
		select {
		case <-t.ln.done:
			return
		case <-time.After(tunnelBackoff):
		}
	}
}

func (t *tunnel) control() error {
	d := net.Dialer{Timeout: tunnelDialTO}
	c, err := d.Dial("tcp", t.host)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.Write([]byte(tunnelProto + " " + t.token + " " + t.key + "\n")); err != nil {
		return err
	}
	br := bufio.NewReader(c)
	// Bounded handshake: a silent listener must not hang the reconnect loop.
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := br.ReadString('\n')
	if err != nil {
		return err
	}
	if got := strings.TrimSpace(line); got != "OK" {
		return fmt.Errorf("ingress refused: %q", got)
	}
	_ = c.SetReadDeadline(time.Time{})
	log.Printf("relay: tunnel connected to %s as key %q", t.host, t.key)

	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return err
		}
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "NEW":
			if len(fields) != 2 {
				log.Printf("relay: malformed NEW frame %q", line)
				continue
			}
			go t.data(fields[1])
		case "PING":
			if _, err := c.Write([]byte("PONG\n")); err != nil {
				return err
			}
		default:
			log.Printf("relay: unknown control frame %q", line)
		}
	}
}

// data dials a dedicated conn for one proxied connection and hands it to the
// pseudo-listener (which queues it for http.Server).
func (t *tunnel) data(id string) {
	d := net.Dialer{Timeout: tunnelDialTO}
	c, err := d.Dial("tcp", t.host)
	if err != nil {
		log.Printf("relay: stream %s data dial failed: %v", id, err)
		return
	}
	if _, err := c.Write([]byte(tunnelProto + " " + t.token + " " + t.key + " DATA " + id + "\n")); err != nil {
		c.Close()
		return
	}
	select {
	case t.ln.conns <- c:
	case <-t.ln.done:
		c.Close()
	case <-time.After(tunnelStreamTO):
		log.Printf("relay: stream %s never consumed, dropping", id)
		c.Close()
	}
}
