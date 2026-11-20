package googleprov

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// flexInt64 accepts the string or number forms Google uses for size and version.
type flexInt64 int64

func (n *flexInt64) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			return nil
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return err
		}
		*n = flexInt64(v)
		return nil
	}
	v, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil {
		return err
	}
	*n = flexInt64(v)
	return nil
}
