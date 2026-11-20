package googleprov

import (
	"context"
	"net/url"
	"sort"

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
