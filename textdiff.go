package lifediff

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// MaxDriveTextBytes is the most text stored for one Drive file.
// Longer exports and downloads are cut off and marked truncated.
const MaxDriveTextBytes = 64 << 10

// MaxDriveTextFiles is how many files get text stored in one snapshot.
const MaxDriveTextFiles = 40

// DriveText is plain text captured for a diff. It is file text, not a secret.
// Snapshots that contain it are local files with mode 0600.
type DriveText struct {
	Text        string `json:"text,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Unavailable string `json:"unavailable,omitempty"`
}

// DriveTextKind reports how full mode should read a file.
// An empty result means the file is not diffed as text (images, folders, binaries).
func DriveTextKind(mime string) string {
	switch mime {
	case "application/vnd.google-apps.document":
		return "document"
	case "application/vnd.google-apps.spreadsheet":
		return "spreadsheet"
	case "application/vnd.google-apps.presentation":
		return "presentation"
	}
	if strings.HasPrefix(mime, "text/") {
		return "plain"
	}
	switch mime {
	case "application/json", "application/xml", "application/javascript",
		"application/x-javascript", "application/yaml", "application/x-yaml",
		"application/csv", "application/ld+json":
		return "plain"
	default:
		return ""
	}
}

func clipStoredText(text string, already bool) (string, bool) {
	text = normalizeDoc(text)
	if len(text) <= MaxDriveTextBytes {
		return text, already
	}
	cut := MaxDriveTextBytes
	for cut > 0 && !utf8.ValidString(text[:cut]) {
		cut--
	}
	return text[:cut], true
}

func normalizeDoc(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return s
}

func splitDocLines(s string) []string {
	s = normalizeDoc(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func textEditSentence(name, before, after string, truncated bool) string {
	added, removed := changedLines(before, after)
	added = dropBlank(added)
	removed = dropBlank(removed)
	var sentence string
	switch {
	case len(added) == 0 && len(removed) == 0:
		sentence = fmt.Sprintf("Updated the text of %s.", quoteName(name))
	case len(added) <= 2 && len(removed) <= 2 && quotableLines(added) && quotableLines(removed):
		var bits []string
		if len(removed) > 0 {
			bits = append(bits, "removed "+joinQuoted(removed))
		}
		if len(added) > 0 {
			bits = append(bits, "added "+joinQuoted(added))
		}
		sentence = fmt.Sprintf("Updated the text of %s: %s.", quoteName(name), strings.Join(bits, " and "))
	default:
		sentence = fmt.Sprintf("Updated the text of %s (%d lines added, %d lines removed).", quoteName(name), len(added), len(removed))
	}
	if truncated {
		sentence += " The stored text was cut off."
	}
	return sentence
}

func changedLines(before, after string) (added, removed []string) {
	b := splitDocLines(before)
	a := splitDocLines(after)
	if len(b) > 400 || len(a) > 400 {
		return bagDelta(b, a)
	}
	return lcsDelta(b, a)
}

func lcsDelta(before, after []string) (added, removed []string) {
	n, m := len(before), len(after)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if before[i] == after[j] {
				dp[i][j] = dp[i+1][j+1] + 1
				continue
			}
			if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
				continue
			}
			dp[i][j] = dp[i][j+1]
		}
	}
	i, j := 0, 0
	for i < n && j < m {
		if before[i] == after[j] {
			i++
			j++
			continue
		}
		if dp[i+1][j] >= dp[i][j+1] {
			removed = append(removed, before[i])
			i++
			continue
		}
		added = append(added, after[j])
		j++
	}
	removed = append(removed, before[i:]...)
	added = append(added, after[j:]...)
	return added, removed
}

func bagDelta(before, after []string) (added, removed []string) {
	left := map[string]int{}
	for _, line := range before {
		left[line]++
	}
	for _, line := range after {
		if left[line] > 0 {
			left[line]--
			continue
		}
		added = append(added, line)
	}
	for _, line := range before {
		if left[line] > 0 {
			removed = append(removed, line)
			left[line]--
		}
	}
	return added, removed
}

func dropBlank(lines []string) []string {
	var out []string
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

func quotableLines(lines []string) bool {
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == "" || len([]rune(t)) > 80 {
			return false
		}
	}
	return true
}

func joinQuoted(lines []string) string {
	parts := make([]string, len(lines))
	for i, line := range lines {
		parts[i] = strconvQuote(strings.TrimSpace(line))
	}
	return strings.Join(parts, " and ")
}

func textFieldPair(before, after string) (string, string) {
	if textIsShort(before) && textIsShort(after) {
		return strings.TrimRight(normalizeDoc(before), "\n"), strings.TrimRight(normalizeDoc(after), "\n")
	}
	added, removed := changedLines(before, after)
	return clipMarked(removed, "- "), clipMarked(added, "+ ")
}

func textIsShort(s string) bool {
	return len(splitDocLines(s)) <= 40 && len(s) <= 2500
}

func clipMarked(lines []string, prefix string) string {
	const maxLines = 30
	n := len(lines)
	if n > maxLines {
		lines = lines[:maxLines]
	}
	var b strings.Builder
	for i, line := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(prefix)
		b.WriteString(line)
	}
	if n > maxLines {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("… more lines omitted")
	}
	return b.String()
}

func replaceContentsSentence(summary, name string) (string, bool) {
	generic := fmt.Sprintf("Updated the contents of %s.", quoteName(name))
	next := fmt.Sprintf("Saved a new version of %s. The exported text matches the snapshot.", quoteName(name))
	if !strings.Contains(summary, generic) {
		return summary, false
	}
	return strings.Replace(summary, generic, next, 1), true
}

func mergeTextSentence(summary, name, sentence string) string {
	generic := fmt.Sprintf("Updated the contents of %s.", quoteName(name))
	if strings.Contains(summary, generic) {
		return strings.Replace(summary, generic, sentence, 1)
	}
	if strings.TrimSpace(summary) == "" {
		return sentence
	}
	return summary + " " + sentence
}
