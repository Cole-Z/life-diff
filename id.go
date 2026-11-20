package lifediff

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

func newID(prefix string, now time.Time) string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// The timestamp still makes the id unique for a single process.
		buf = [4]byte{0, 0, 0, 0}
	}
	return fmt.Sprintf("%s_%s_%s", prefix, now.UTC().Format("20060102T150405Z"), hex.EncodeToString(buf[:]))
}
