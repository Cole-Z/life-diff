package lifediff

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func quoteName(s string) string {
	if strings.TrimSpace(s) == "" {
		return strconv.Quote("Untitled")
	}
	return strconv.Quote(s)
}

func displayName(s string) string {
	if strings.TrimSpace(s) == "" {
		return "Untitled"
	}
	return strings.TrimSpace(s)
}

func normNewlines(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}

func fold(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func sameStrings(a, b []string) bool {
	aa := sortedCopy(a)
	bb := sortedCopy(b)
	if len(aa) != len(bb) {
		return false
	}
	for i := range aa {
		if aa[i] != bb[i] {
			return false
		}
	}
	return true
}

func joinPeople(list []string) string {
	if len(list) == 0 {
		return "nobody"
	}
	cp := sortedCopy(list)
	return strings.Join(cp, ", ")
}

// ChangeID is the stable id providers should use for one change.
func ChangeID(service Service, resourceID string, kind ChangeKind) string {
	return changeID(service, resourceID, kind)
}

func changeID(service Service, resourceID string, kind ChangeKind) string {
	sum := sha256.Sum256([]byte(string(service) + "\n" + resourceID + "\n" + string(kind)))
	return "chg_" + hex.EncodeToString(sum[:6])
}

func safeLink(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	return raw
}

func formatBytes(n int64) string {
	if n < 0 {
		return ""
	}
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d bytes", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 3; v /= unit {
		div *= unit
		exp++
	}
	suffix := []string{"KB", "MB", "GB", "TB"}[exp]
	return fmt.Sprintf("%.1f %s", float64(n)/float64(div), suffix)
}

func friendlyType(mime string) string {
	switch mime {
	case "application/vnd.google-apps.document":
		return "Google Doc"
	case "application/vnd.google-apps.spreadsheet":
		return "spreadsheet"
	case "application/vnd.google-apps.presentation":
		return "presentation"
	case "application/vnd.google-apps.folder":
		return "folder"
	case "application/vnd.google-apps.form":
		return "form"
	case "application/pdf":
		return "PDF"
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "Word document"
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "Excel spreadsheet"
	case "text/plain":
		return "text file"
	case "":
		return "file"
	default:
		return "file"
	}
}

func isFolder(mime string) bool {
	return mime == "application/vnd.google-apps.folder"
}

const (
	fieldTitle    = "title"
	fieldStart    = "start"
	fieldEnd      = "end"
	fieldLocation = "location"
	fieldNotes    = "notes"
	fieldGuests   = "guests"
	fieldStatus   = "status"
	fieldName     = "name"
	fieldFolder   = "folder"
	fieldTrashed  = "trashed"
	fieldContent  = "content"
	fieldType     = "type"
	fieldDetails  = "details"
	fieldActivity = "activity"
	fieldRevision = "revision"
	fieldText     = "text"
)

func fieldLabel(field string) string {
	switch field {
	case fieldTitle:
		return "Title"
	case fieldStart:
		return "Starts"
	case fieldEnd:
		return "Ends"
	case fieldLocation:
		return "Location"
	case fieldNotes:
		return "Notes"
	case fieldGuests:
		return "Guests"
	case fieldStatus:
		return "Status"
	case fieldName:
		return "Name"
	case fieldFolder:
		return "Folder"
	case fieldTrashed:
		return "Trash"
	case fieldContent:
		return "Contents"
	case fieldType:
		return "Type"
	case fieldDetails:
		return "Details"
	case fieldActivity:
		return "Activity"
	case fieldRevision:
		return "Revision"
	case fieldText:
		return "Text"
	default:
		return field
	}
}

func edit(field, before, after string) FieldChange {
	return FieldChange{
		Field:  field,
		Label:  fieldLabel(field),
		Before: before,
		After:  after,
	}
}

func findField(fields []FieldChange, name string) (FieldChange, bool) {
	for _, f := range fields {
		if f.Field == name {
			return f, true
		}
	}
	return FieldChange{}, false
}
