package crypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestGCMRoundTrip(t *testing.T) {
	key, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	pt := []byte("the quick brown fox")
	ct, nonce, tag, err := SealGCM(key, pt, nil)
	if err != nil {
		t.Fatal(err)
	}
	out, err := OpenGCM(key, ct, nonce, tag, nil)
	if err != nil {
		t.Fatalf("OpenGCM: %v", err)
	}
	if !bytes.Equal(out, pt) {
		t.Fatalf("round trip mismatch: %q != %q", out, pt)
	}
	// Tampered ciphertext must fail.
	ct[0] ^= 0xff
	if _, err := OpenGCM(key, ct, nonce, tag, nil); err == nil {
		t.Fatal("expected auth failure on tampered ciphertext")
	}
}

func TestSealString(t *testing.T) {
	key, _ := NewKey()
	ct, nonce, tag, err := SealString(key, "hello world")
	if err != nil {
		t.Fatal(err)
	}
	got, err := OpenString(key, ct, nonce, tag)
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestPBKDF2KnownVector(t *testing.T) {
	// RFC 6070 test vector 1: PBKDF2-HMAC-SHA1("password","salt",1,20)
	// = 0c60c80f961f0e71f3a9b524af6012062fe037a6
	dk := PBKDF2SHA1([]byte("password"), []byte("salt"), 1, 20)
	if hex.EncodeToString(dk) != "0c60c80f961f0e71f3a9b524af6012062fe037a6" {
		t.Fatalf("PBKDF2 vector 1 mismatch: %x", dk)
	}
	// RFC 6070 test vector 2: PBKDF2-HMAC-SHA1("password","salt",2,20)
	// = ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957
	dk2 := PBKDF2SHA1([]byte("password"), []byte("salt"), 2, 20)
	if hex.EncodeToString(dk2) != "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957" {
		t.Fatalf("PBKDF2 vector 2 mismatch: %x", dk2)
	}
}

func TestDpapiDevRoundTrip(t *testing.T) {
	secret := []byte("dpapi-secret-bytes")
	blob, err := ProtectBytes(secret, []byte("entropy"))
	if err != nil {
		t.Fatalf("ProtectBytes: %v", err)
	}
	got, err := UnprotectBytes(blob, []byte("entropy"))
	if err != nil {
		t.Fatalf("UnprotectBytes: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("mismatch: %q", got)
	}
	// Wrong entropy must fail.
	if _, err := UnprotectBytes(blob, []byte("wrong")); err == nil {
		t.Fatal("expected failure with wrong entropy")
	}
}

func TestShaHmacHelpers(t *testing.T) {
	if Sha256Hex([]byte("")) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatal("sha256 of empty mismatch")
	}
	// HMAC-SHA256("key","The quick brown fox jumps over the lazy dog")
	h := HmacSha256Hex([]byte("key"), []byte("The quick brown fox jumps over the lazy dog"))
	if h != "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8" {
		t.Fatalf("hmac mismatch: %s", h)
	}
}

func TestChromeV10KeyParsing(t *testing.T) {
	// A fake Windows "DPAPI" prefixed key, using the dev DPAPI to produce the blob.
	rawKey := bytes.Repeat([]byte{0x42}, 32)
	blob, err := ProtectBytes(rawKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	localState := `{"os_crypt":{"encrypted_key":"` +
		B64Encode(append([]byte("DPAPI"), blob...)) + `"}}`
	payload, err := ParseLocalStateKey([]byte(localState))
	if err != nil {
		t.Fatalf("ParseLocalStateKey: %v", err)
	}
	ck, err := DecodeChromeKey(payload)
	if err != nil {
		t.Fatalf("DecodeChromeKey: %v", err)
	}
	if !bytes.Equal(ck.Raw, rawKey) {
		t.Fatalf("decoded key mismatch")
	}
}

func TestChromeV10LinuxKey(t *testing.T) {
	rawKey := bytes.Repeat([]byte{0x77}, 32)
	localState := `{"os_crypt":{"encrypted_key":"` + B64Encode(append([]byte("v10"), rawKey...)) + `"}}`
	payload, err := ParseLocalStateKey([]byte(localState))
	if err != nil {
		t.Fatal(err)
	}
	ck, err := DecodeChromeKey(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ck.Raw, rawKey) {
		t.Fatal("v10 key mismatch")
	}
}
