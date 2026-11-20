package lifediff

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Store saves snapshots and receipts on the local disk.
// Files are written with mode 0600 and directories with mode 0700.
type Store struct {
	Dir string
}

func (s Store) dir() string { return s.Dir }

// SaveSnapshot writes the snapshot and marks it as the current one.
func (s Store) SaveSnapshot(snap Snapshot) error {
	if snap.ID == "" {
		return fmt.Errorf("snapshot is missing an id")
	}
	path := filepath.Join(s.dir(), "snapshots", snap.ID+".json")
	if err := writePrivateJSON(path, snap); err != nil {
		return err
	}
	return writePrivate(filepath.Join(s.dir(), "current_snapshot"), []byte(snap.ID+"\n"))
}

// LoadSnapshot reads a snapshot by id.
func (s Store) LoadSnapshot(id string) (Snapshot, error) {
	if err := safeID(id); err != nil {
		return Snapshot{}, err
	}
	var snap Snapshot
	if err := readJSON(filepath.Join(s.dir(), "snapshots", id+".json"), &snap); err != nil {
		return Snapshot{}, err
	}
	if err := checkSchema(snap.SchemaVersion); err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

// CurrentSnapshot loads the snapshot most recently saved in this store.
func (s Store) CurrentSnapshot() (Snapshot, error) {
	b, err := os.ReadFile(filepath.Join(s.dir(), "current_snapshot"))
	if err != nil {
		if os.IsNotExist(err) {
			return Snapshot{}, ErrNoSnapshot
		}
		return Snapshot{}, err
	}
	id := strings.TrimSpace(string(b))
	if id == "" {
		return Snapshot{}, ErrNoSnapshot
	}
	return s.LoadSnapshot(id)
}

// SaveReceipt writes the receipt JSON and HTML report.
func (s Store) SaveReceipt(r Receipt, html []byte) error {
	if r.ID == "" {
		return fmt.Errorf("receipt is missing an id")
	}
	if err := writePrivateJSON(filepath.Join(s.dir(), "receipts", r.ID+".json"), r); err != nil {
		return err
	}
	if len(html) > 0 {
		if err := writePrivate(filepath.Join(s.dir(), "receipts", r.ID+".html"), html); err != nil {
			return err
		}
	}
	return writePrivate(filepath.Join(s.dir(), "current_receipt"), []byte(r.ID+"\n"))
}

// CurrentReceipt loads the receipt most recently saved in this store.
func (s Store) CurrentReceipt() (Receipt, error) {
	b, err := os.ReadFile(filepath.Join(s.dir(), "current_receipt"))
	if err != nil {
		if os.IsNotExist(err) {
			return Receipt{}, fmt.Errorf("no receipt yet")
		}
		return Receipt{}, err
	}
	id := strings.TrimSpace(string(b))
	if id == "" {
		return Receipt{}, fmt.Errorf("no receipt yet")
	}
	return s.LoadReceipt(id)
}

// LoadReceipt reads a receipt by id.
func (s Store) LoadReceipt(id string) (Receipt, error) {
	if err := safeID(id); err != nil {
		return Receipt{}, err
	}
	var r Receipt
	if err := readJSON(filepath.Join(s.dir(), "receipts", id+".json"), &r); err != nil {
		return Receipt{}, err
	}
	if err := checkSchema(r.SchemaVersion); err != nil {
		return Receipt{}, err
	}
	return r, nil
}

// ReceiptPath returns the JSON path for a receipt id.
func (s Store) ReceiptPath(id string) string {
	return filepath.Join(s.dir(), "receipts", id+".json")
}

// ReportPath returns the HTML path for a receipt id.
func (s Store) ReportPath(id string) string {
	return filepath.Join(s.dir(), "receipts", id+".html")
}

func checkSchema(v string) error {
	if v == "" {
		return fmt.Errorf("document is missing schemaVersion")
	}
	if !strings.HasPrefix(v, "1.") {
		return fmt.Errorf("unsupported schemaVersion %s", v)
	}
	return nil
}

func safeID(id string) error {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		return fmt.Errorf("invalid id")
	}
	return nil
}

func writePrivateJSON(path string, v any) error {
	data, err := Marshal(v)
	if err != nil {
		return err
	}
	return writePrivate(path, data)
}

// Marshal encodes a document with stable, readable JSON.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writePrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil {
		_ = os.Remove(tmp)
		return werr
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return cerr
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Chmod(path, 0o600)
}

func readJSON(path string, dest any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, dest); err != nil {
		return fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	return nil
}
