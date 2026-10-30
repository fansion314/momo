package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"time"
)

// These commands expose metadata and account operations, never plaintext profiles
// or an arbitrary native subcommand. The state path is owned by this service and
// sits outside data/, so configuration snapshots cannot overwrite the ledger.
func allowedTiziAction(action string) bool {
	switch action {
	case "status", "register", "registration-status", "complete-registration", "reset-request", "reset-confirm", "login", "logout", "sync", "refresh", "usage":
		return true
	}
	return false
}

type limitedTiziOutput struct{ bytes.Buffer }

// Account network I/O must not hold the core lifecycle lock. Each operation is
// still tied to the application's authorized lease and cancelled when it expires.
func (s *service) serveTiziAction(w http.ResponseWriter, r *http.Request) {
	s.authMu.Lock()
	if !sessionMatches(s.token, r.Header.Get("X-Momo-Session")) || time.Since(s.lease) > 10*time.Second {
		s.authMu.Unlock()
		http.Error(w, "session required", http.StatusUnauthorized)
		return
	}
	if len(s.tiziOperations) >= 8 {
		s.authMu.Unlock()
		http.Error(w, "account operations busy", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	if s.tiziOperations == nil {
		s.tiziOperations = make(map[uint64]context.CancelFunc)
	}
	s.tiziSequence++
	id := s.tiziSequence
	s.tiziOperations[id] = cancel
	s.authMu.Unlock()
	closed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = r.Body.Close()
		case <-closed:
		}
	}()
	defer func() {
		close(closed)
		cancel()
		s.authMu.Lock()
		delete(s.tiziOperations, id)
		s.authMu.Unlock()
	}()
	if err := s.tiziAction(w, r.WithContext(ctx)); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	}
}

func (b *limitedTiziOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 4<<20 {
		return 0, errors.New("native response exceeds limit")
	}
	return b.Buffer.Write(p)
}

func (s *service) tiziAction(w http.ResponseWriter, r *http.Request) error {
	var input struct {
		Action  string          `json:"action"`
		Payload json.RawMessage `json:"payload"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(&input); err != nil {
		return errors.New("invalid account operation")
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected one account operation")
	}
	if !allowedTiziAction(input.Action) {
		return errors.New("account operation forbidden")
	}
	if len(input.Payload) == 0 {
		input.Payload = json.RawMessage(`{}`)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(input.Payload, &payload); err != nil || payload == nil {
		return errors.New("invalid operation payload")
	}
	if _, ok := payload["state-dir"]; ok {
		return errors.New("state directory cannot be supplied")
	}
	if _, ok := payload["state_dir"]; ok {
		return errors.New("state directory cannot be supplied")
	}
	core := filepath.Join(s.root, "mihomomo")
	if err := protectedAncestors(s.root); err != nil {
		return err
	}
	hash, err := fileHash(core)
	if err != nil || hash != s.install.CoreHash {
		return errors.New("installed core hash mismatch")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, core, "tizi", "--state-dir", filepath.Join(s.root, "tizi"), input.Action)
	cmd.Stdin = bytes.NewReader(input.Payload)
	var output limitedTiziOutput
	cmd.Stdout = &output
	// Native stderr may contain transport details; never persist it in core.log.
	cmd.Stderr = io.Discard
	runErr := cmd.Run()
	var envelope struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error json.RawMessage `json:"error"`
	}
	if err = json.Unmarshal(output.Bytes(), &envelope); err != nil || (!envelope.OK && len(envelope.Error) == 0) || (envelope.OK && len(envelope.Data) == 0) {
		return errors.New("installed core does not support account operations")
	}
	if runErr != nil && envelope.OK {
		return errors.New("account operation failed")
	}
	w.Header().Set("Content-Type", "application/json")
	_, err = w.Write(output.Bytes())
	return err
}
