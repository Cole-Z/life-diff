package googleprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cole-Z/life-diff"
)

const (
	drivePageSize = "100"
	driveMaxPages = 40
	fileFields    = "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,trashed,parents,size,md5Checksum,version,webViewLink)"
	changeFields  = "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,createdTime,trashed,parents,size,md5Checksum,version,webViewLink))"
)

// Drive reads file metadata and the changes feed. It implements lifediff.DriveReader.
type Drive struct {
	Client *Client
}

var _ lifediff.DriveReader = (*Drive)(nil)

func (d *Drive) client() *Client {
	if d != nil && d.Client != nil {
		return d.Client
	}
	return New(nil)
}

// StartPageToken returns the cursor used to read changes after a snapshot.
func (d *Drive) StartPageToken(ctx context.Context) (string, error) {
	var resp struct {
		StartPageToken string `json:"startPageToken"`
	}
	q := url.Values{}
	q.Set("supportsAllDrives", "true")
	if err := d.client().getJSON(ctx, "/drive/v3/changes/startPageToken", q, &resp); err != nil {
		return "", err
	}
	if resp.StartPageToken == "" {
		return "", errEmpty("drive start page token")
	}
	return resp.StartPageToken, nil
}

// ListFiles returns metadata for files matching query, newest modification first.
func (d *Drive) ListFiles(ctx context.Context, query string, maxFiles int) (lifediff.DriveFileList, error) {
	if maxFiles <= 0 {
		maxFiles = lifediff.DefaultMaxDriveFiles
	}
	q := url.Values{}
	q.Set("pageSize", drivePageSize)
	q.Set("fields", fileFields)
	q.Set("orderBy", "modifiedTime desc")
	q.Set("spaces", "drive")
	q.Set("corpora", "user")
	q.Set("supportsAllDrives", "true")
	if query != "" {
		q.Set("q", query)
	}
	var all []lifediff.DriveFile
	pageToken := ""
	for page := 0; page < driveMaxPages; page++ {
		if pageToken != "" {
			q.Set("pageToken", pageToken)
		} else {
			q.Del("pageToken")
		}
		var resp struct {
			Files         []driveFile `json:"files"`
			NextPageToken string      `json:"nextPageToken"`
		}
		if err := d.client().getJSON(ctx, "/drive/v3/files", q, &resp); err != nil {
			return lifediff.DriveFileList{}, err
		}
		for _, item := range resp.Files {
			file := convertFile(item)
			if file.ID == "" {
				continue
			}
			all = append(all, file)
			if len(all) >= maxFiles {
				return lifediff.DriveFileList{Files: all[:maxFiles], Truncated: true}, nil
			}
		}
		if resp.NextPageToken == "" {
			if all == nil {
				all = []lifediff.DriveFile{}
			}
			return lifediff.DriveFileList{Files: all}, nil
		}
		if resp.NextPageToken == pageToken {
			return lifediff.DriveFileList{}, errEmpty("drive repeated a page token")
		}
		pageToken = resp.NextPageToken
	}
	return lifediff.DriveFileList{Files: all, Truncated: true}, nil
}

// ListChanges reads the changes feed starting at pageToken.
func (d *Drive) ListChanges(ctx context.Context, pageToken string) (lifediff.DriveChangeList, error) {
	q := url.Values{}
	q.Set("pageSize", drivePageSize)
	q.Set("fields", changeFields)
	q.Set("includeRemoved", "true")
	q.Set("supportsAllDrives", "true")
	q.Set("includeItemsFromAllDrives", "true")
	q.Set("spaces", "drive")
	var all []lifediff.DriveChange
	token := pageToken
	for page := 0; page < driveMaxPages; page++ {
		q.Set("pageToken", token)
		var resp struct {
			Changes           []driveChange `json:"changes"`
			NextPageToken     string        `json:"nextPageToken"`
			NewStartPageToken string        `json:"newStartPageToken"`
		}
		if err := d.client().getJSON(ctx, "/drive/v3/changes", q, &resp); err != nil {
			return lifediff.DriveChangeList{}, err
		}
		for _, ch := range resp.Changes {
			all = append(all, convertChange(ch))
		}
		if resp.NextPageToken == "" {
			if all == nil {
				all = []lifediff.DriveChange{}
			}
			return lifediff.DriveChangeList{Changes: all, NewStartToken: resp.NewStartPageToken}, nil
		}
		if resp.NextPageToken == token {
			return lifediff.DriveChangeList{}, errEmpty("drive changes repeated a page token")
		}
		token = resp.NextPageToken
	}
	return lifediff.DriveChangeList{Changes: all, NewStartToken: token, Truncated: true}, nil
}

type driveFile struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MimeType     string    `json:"mimeType"`
	ModifiedTime string    `json:"modifiedTime"`
	CreatedTime  string    `json:"createdTime"`
	Trashed      bool      `json:"trashed"`
	Parents      []string  `json:"parents"`
	Size         flexInt64 `json:"size"`
	MD5          string    `json:"md5Checksum"`
	Version      flexInt64 `json:"version"`
	WebViewLink  string    `json:"webViewLink"`
}

type driveChange struct {
	FileID  string     `json:"fileId"`
	Removed bool       `json:"removed"`
	Time    string     `json:"time"`
	File    *driveFile `json:"file"`
}

func convertFile(in driveFile) lifediff.DriveFile {
	f := lifediff.DriveFile{
		ID:       in.ID,
		Name:     in.Name,
		MimeType: in.MimeType,
		Trashed:  in.Trashed,
		Parents:  append([]string(nil), in.Parents...),
		Size:     int64(in.Size),
		MD5:      in.MD5,
		Version:  int64(in.Version),
		Link:     in.WebViewLink,
	}
	sort.Strings(f.Parents)
	f.ModifiedTime, _ = parseGoogleTime(in.ModifiedTime)
	f.CreatedTime, _ = parseGoogleTime(in.CreatedTime)
	return f
}

func convertChange(in driveChange) lifediff.DriveChange {
	ch := lifediff.DriveChange{FileID: in.FileID, Removed: in.Removed}
	ch.Time, _ = parseGoogleTime(in.Time)
	if in.File != nil {
		file := convertFile(*in.File)
		if file.ID == "" {
			file.ID = in.FileID
		}
		ch.File = &file
	}
	return ch
}

type strError string

func (e strError) Error() string { return string(e) }

func errEmpty(msg string) error { return strError(msg) }

// Revisions lists revision metadata. It never requests alt=media.
func (d *Drive) Revisions(ctx context.Context, fileID string) ([]lifediff.DriveRevision, error) {
	if fileID == "" {
		return nil, errEmpty("drive revision file id")
	}
	q := url.Values{}
	q.Set("pageSize", "20")
	q.Set("fields", "revisions(id,modifiedTime,size,md5Checksum)")
	var resp struct {
		Revisions []struct {
			ID           string    `json:"id"`
			ModifiedTime string    `json:"modifiedTime"`
			Size         flexInt64 `json:"size"`
			MD5          string    `json:"md5Checksum"`
		} `json:"revisions"`
	}
	path := "/drive/v3/files/" + url.PathEscape(fileID) + "/revisions"
	if err := d.client().getJSON(ctx, path, q, &resp); err != nil {
		return nil, err
	}
	out := make([]lifediff.DriveRevision, 0, len(resp.Revisions))
	for _, rev := range resp.Revisions {
		item := lifediff.DriveRevision{ID: rev.ID, Size: int64(rev.Size), MD5: rev.MD5}
		item.ModifiedTime, _ = parseGoogleTime(rev.ModifiedTime)
		out = append(out, item)
	}
	return out, nil
}

// ActivitySince reads the Drive Activity record since the given time.
// The query is a metadata filter. File bodies are not part of this API.
func (d *Drive) ActivitySince(ctx context.Context, since time.Time) ([]lifediff.DriveActivity, error) {
	if since.IsZero() {
		since = time.Now().UTC().Add(-24 * time.Hour)
	}
	body := map[string]any{
		"filter":   fmt.Sprintf("time >= %d", since.UTC().UnixMilli()),
		"pageSize": 50,
	}
	var resp struct {
		Activities []struct {
			PrimaryActionDetail map[string]json.RawMessage `json:"primaryActionDetail"`
			Targets             []struct {
				DriveItem struct {
					Name  string `json:"name"`
					Title string `json:"title"`
				} `json:"driveItem"`
			} `json:"targets"`
			Timestamp string `json:"timestamp"`
		} `json:"activities"`
	}
	if err := d.client().postJSON(ctx, "/driveactivity/v2/activity:query", body, &resp); err != nil {
		return nil, err
	}
	var out []lifediff.DriveActivity
	for _, act := range resp.Activities {
		when, _ := parseGoogleTime(act.Timestamp)
		action := activityAction(act.PrimaryActionDetail)
		for _, target := range act.Targets {
			id := strings.TrimPrefix(target.DriveItem.Name, "items/")
			if id == "" {
				continue
			}
			out = append(out, lifediff.DriveActivity{
				FileID: id,
				Time:   when,
				Action: action,
				Title:  target.DriveItem.Title,
			})
		}
	}
	return out, nil
}

const maxPlainDownload = 512 << 10

// FileText reads text for a full-mode diff.
// Docs and Slides are exported as text/plain. Sheets are exported as CSV.
// Plain files are downloaded with alt=media. Other types are skipped.
// This method only uses GET.
func (d *Drive) FileText(ctx context.Context, file lifediff.DriveFile) (lifediff.DriveText, error) {
	kind := lifediff.DriveTextKind(file.MimeType)
	switch kind {
	case "document", "presentation":
		return d.exportText(ctx, file.ID, "text/plain", kind)
	case "spreadsheet":
		return d.exportText(ctx, file.ID, "text/csv", kind)
	case "plain":
		if file.Size > maxPlainDownload {
			return lifediff.DriveText{Unavailable: "file is too large to download as text"}, nil
		}
		return d.downloadText(ctx, file.ID, kind)
	default:
		return lifediff.DriveText{Unavailable: "not a text file"}, nil
	}
}

func (d *Drive) exportText(ctx context.Context, fileID, mime, kind string) (lifediff.DriveText, error) {
	if fileID == "" {
		return lifediff.DriveText{}, errEmpty("drive export file id")
	}
	q := url.Values{}
	q.Set("mimeType", mime)
	path := "/drive/v3/files/" + url.PathEscape(fileID) + "/export"
	body, truncated, err := d.client().getBytes(ctx, path, q, lifediff.MaxDriveTextBytes)
	if err != nil {
		return lifediff.DriveText{}, err
	}
	return bytesToDriveText(body, truncated, kind)
}

func (d *Drive) downloadText(ctx context.Context, fileID, kind string) (lifediff.DriveText, error) {
	if fileID == "" {
		return lifediff.DriveText{}, errEmpty("drive download file id")
	}
	q := url.Values{}
	q.Set("alt", "media")
	q.Set("supportsAllDrives", "true")
	path := "/drive/v3/files/" + url.PathEscape(fileID)
	body, truncated, err := d.client().getBytes(ctx, path, q, lifediff.MaxDriveTextBytes)
	if err != nil {
		return lifediff.DriveText{}, err
	}
	return bytesToDriveText(body, truncated, kind)
}

func bytesToDriveText(body []byte, truncated bool, kind string) (lifediff.DriveText, error) {
	if truncated {
		for len(body) > 0 && !utf8.Valid(body) {
			body = body[:len(body)-1]
		}
	}
	if !utf8.Valid(body) {
		return lifediff.DriveText{Unavailable: "not text"}, nil
	}
	return lifediff.DriveText{Text: string(body), Truncated: truncated, Kind: kind}, nil
}

func activityAction(detail map[string]json.RawMessage) string {
	order := []string{"create", "edit", "rename", "move", "delete", "restore"}
	for _, name := range order {
		if _, ok := detail[name]; ok {
			return name
		}
	}
	for name := range detail {
		return name
	}
	return ""
}
