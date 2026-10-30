//go:build tizi

package tizi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// BuildKeys is injected by the private release build. Format id:base64-32byte-key[,previous:...].
// It deliberately has no default or environment fallback.
var BuildKeys string

type sealedFile struct {
	Version int    `json:"version"`
	KeyID   string `json:"key_id"`
	Salt    []byte `json:"salt"`
	Nonce   []byte `json:"nonce"`
	Data    []byte `json:"data"`
}

func keyRing() (map[string][]byte, string, error) {
	keys := map[string][]byte{}
	first := ""
	for _, entry := range strings.Split(BuildKeys, ",") {
		id, b64, ok := strings.Cut(entry, ":")
		if !ok || id == "" {
			return nil, "", errors.New("Tizi build encryption keys are not configured")
		}
		b, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(b) != 32 {
			return nil, "", errors.New("Invalid tizi build encryption key")
		}
		if _, ok := keys[id]; ok {
			return nil, "", errors.New("Duplicate tizi key ID")
		}
		keys[id] = b
		if first == "" {
			first = id
		}
	}
	return keys, first, nil
}
func cryptAEAD(key, salt []byte, purpose string) (cipher.AEAD, error) {
	h := sha256.New()
	h.Write(key)
	h.Write(salt)
	h.Write([]byte(purpose))
	block, e := aes.NewCipher(h.Sum(nil))
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func seal(purpose string, value any) ([]byte, error) {
	keys, id, e := keyRing()
	if e != nil {
		return nil, e
	}
	s := sealedFile{Version: 1, KeyID: id, Salt: make([]byte, 32)}
	if _, e = rand.Read(s.Salt); e != nil {
		return nil, e
	}
	a, e := cryptAEAD(keys[id], s.Salt, purpose)
	if e != nil {
		return nil, e
	}
	s.Nonce = make([]byte, a.NonceSize())
	if _, e = rand.Read(s.Nonce); e != nil {
		return nil, e
	}
	plain, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	s.Data = a.Seal(nil, s.Nonce, plain, []byte("tizi/1/"+id+"/"+purpose))
	return json.Marshal(s)
}
func unseal(purpose string, data []byte, value any) error {
	keys, _, e := keyRing()
	if e != nil {
		return e
	}
	var s sealedFile
	if e = json.Unmarshal(data, &s); e != nil {
		return errors.New("Corrupt tizi encrypted file")
	}
	key, ok := keys[s.KeyID]
	if !ok || s.Version != 1 || len(s.Salt) != 32 {
		return errors.New("Unsupported tizi encrypted file or key")
	}
	a, e := cryptAEAD(key, s.Salt, purpose)
	if e != nil {
		return e
	}
	if len(s.Nonce) != a.NonceSize() {
		return errors.New("Corrupt tizi nonce")
	}
	plain, e := a.Open(nil, s.Nonce, s.Data, []byte("tizi/1/"+s.KeyID+"/"+purpose))
	if e != nil {
		return errors.New("Tizi encrypted file authentication failed; restore the original file")
	}
	if e = json.Unmarshal(plain, value); e != nil {
		return errors.New("Corrupt tizi encrypted content")
	}
	return nil
}
func writeEncrypted(dir, name string, value any) error {
	data, e := seal(name, value)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".tizi-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(data)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, filepath.Join(dir, name)); e != nil {
		return e
	}
	directory, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer directory.Close()
	return directory.Sync()
}
func readEncrypted(dir, name string, value any) error {
	p := filepath.Join(dir, name)
	st, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Size() > 32<<20 {
		return errors.New("Unsafe tizi encrypted file")
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return e
	}
	return unseal(name, b, value)
}
func validateDir(dir string) error {
	if !filepath.IsAbs(dir) {
		return errors.New("Tizi state directory must be absolute")
	}
	for p := filepath.Clean(dir); p != filepath.Dir(p); p = filepath.Dir(p) {
		st, err := os.Lstat(p)
		if err == nil && st.Mode()&os.ModeSymlink != 0 {
			return errors.New("Tizi state path contains a symlink")
		}
		if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	resolved, e := filepath.EvalSymlinks(dir)
	if e == nil && filepath.Clean(resolved) != filepath.Clean(dir) {
		return errors.New("Tizi state directory must not contain symlinks")
	}
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	return nil
}
