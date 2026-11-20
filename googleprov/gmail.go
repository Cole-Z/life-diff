package googleprov

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cole-Z/life-diff"
)

const gmailMaxMessages = 100

// Gmail reads mailbox metadata: headers, labels, and history.
// It does not request message bodies. It implements lifediff.Provider.
type Gmail struct {
	Client *Client
}

// NewGmail returns the Gmail metadata provider.
func NewGmail(c *Client) lifediff.Provider {
	return &Gmail{Client: c}
}

func (g *Gmail) ID() string { return string(lifediff.ServiceGmail) }

func (g *Gmail) DisplayName() string { return lifediff.ServiceGmail.Display() }

func (g *Gmail) client() *Client {
	if g != nil && g.Client != nil {
		return g.Client
	}
	return New(nil)
}

type gmailState struct {
	Email     string     `json:"email,omitempty"`
	HistoryID string     `json:"historyId,omitempty"`
	Messages  []gmailMsg `json:"messages"`
	Truncated bool       `json:"truncated,omitempty"`
	Mode      string     `json:"mode,omitempty"`
}

type gmailMsg struct {
	ID       string    `json:"id"`
	ThreadID string    `json:"threadId,omitempty"`
	Subject  string    `json:"subject,omitempty"`
	From     string    `json:"from,omitempty"`
	To       string    `json:"to,omitempty"`
	Cc       string    `json:"cc,omitempty"`
	Snippet  string    `json:"snippet,omitempty"`
	Date     time.Time `json:"date,omitempty"`
	Labels   []string  `json:"labels,omitempty"`
}

func (g *Gmail) Snapshot(ctx context.Context, req lifediff.SnapshotRequest) (lifediff.ServiceState, error) {
	st, err := g.listState(ctx)
	if err != nil {
		return lifediff.ServiceState{}, err
	}
	payload, err := encode(st)
	if err != nil {
		return lifediff.ServiceState{}, err
	}
	state := lifediff.ServiceState{
		ID:          g.ID(),
		DisplayName: g.DisplayName(),
		Checked:     true,
		TakenAt:     req.Now.UTC(),
		ItemCount:   len(st.Messages),
		Cursor:      st.HistoryID,
		Payload:     payload,
	}
	if st.Truncated {
		state.Warnings = append(state.Warnings, "Gmail snapshot stored the newest 100 messages. Older mail is not part of this comparison.")
	}
	return state, nil
}

func (g *Gmail) ReadCurrent(ctx context.Context, before lifediff.ServiceState) (lifediff.ServiceState, error) {
	var snap gmailState
	if err := decode(before.Payload, &snap); err != nil {
		return lifediff.ServiceState{}, err
	}
	after, warn, err := g.read(ctx, snap)
	if err != nil {
		return lifediff.ServiceState{}, err
	}
	payload, err := encode(after)
	if err != nil {
		return lifediff.ServiceState{}, err
	}
	state := lifediff.ServiceState{
		ID:          g.ID(),
		DisplayName: g.DisplayName(),
		Checked:     true,
		Mode:        after.Mode,
		ItemCount:   len(after.Messages),
		Cursor:      after.HistoryID,
		Payload:     payload,
	}
	if warn != "" {
		state.Warnings = append(state.Warnings, warn)
	}
	if after.Truncated {
		state.Warnings = append(state.Warnings, "Gmail listed only the newest 100 messages, so a missing older message is not reported as removed.")
	}
	return state, nil
}

func (g *Gmail) read(ctx context.Context, snap gmailState) (gmailState, string, error) {
	if snap.HistoryID != "" {
		after, err := g.applyHistory(ctx, snap)
		if err == nil {
			after.Mode = "history"
			return after, "", nil
		}
		var status *httpStatusError
		if errors.As(err, &status) && status.Status == http.StatusNotFound {
			listed, lerr := g.listState(ctx)
			if lerr != nil {
				return gmailState{}, "", lerr
			}
			listed.Mode = "list"
			return listed, "Gmail history was no longer available. Life Diff listed recent messages again.", nil
		}
		return gmailState{}, "", err
	}
	listed, err := g.listState(ctx)
	if err != nil {
		return gmailState{}, "", err
	}
	listed.Mode = "list"
	return listed, "", nil
}

func (g *Gmail) BuildChanges(before, current lifediff.ServiceState, cc lifediff.CompareContext) (lifediff.ProviderOutput, error) {
	var snap gmailState
	if err := decode(before.Payload, &snap); err != nil {
		return lifediff.ProviderOutput{}, err
	}
	var after gmailState
	if err := decode(current.Payload, &after); err != nil {
		return lifediff.ProviderOutput{}, err
	}
	changes := diffGmail(snap, after, cc)
	intro := "Gmail messages (subject, recipients, labels, and snippet)."
	if after.Email != "" {
		intro = "Gmail metadata for " + after.Email + "."
	} else if snap.Email != "" {
		intro = "Gmail metadata for " + snap.Email + "."
	}
	mode := after.Mode
	if mode == "" {
		mode = "list"
	}
	return lifediff.ProviderOutput{
		Info: lifediff.ProviderInfo{
			ID:          g.ID(),
			DisplayName: g.DisplayName(),
			DiffMode:    mode,
			Intro:       intro,
		},
		Changes:  changes,
		Notes:    []string{"Gmail rows use the subject, recipients, labels, and snippet. Message bodies are not read."},
		Warnings: append([]string{}, current.Warnings...),
	}, nil
}

func (g *Gmail) listState(ctx context.Context) (gmailState, error) {
	var profile struct {
		EmailAddress string `json:"emailAddress"`
		HistoryID    string `json:"historyId"`
	}
	if err := g.client().getJSON(ctx, "/gmail/v1/users/me/profile", nil, &profile); err != nil {
		return gmailState{}, err
	}
	q := url.Values{}
	q.Set("maxResults", strconv.Itoa(gmailMaxMessages))
	q.Set("q", "newer_than:30d")
	var listed struct {
		Messages []struct {
			ID       string `json:"id"`
			ThreadID string `json:"threadId"`
		} `json:"messages"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := g.client().getJSON(ctx, "/gmail/v1/users/me/messages", q, &listed); err != nil {
		return gmailState{}, err
	}
	msgs := make([]gmailMsg, 0, len(listed.Messages))
	for _, item := range listed.Messages {
		if len(msgs) >= gmailMaxMessages {
			break
		}
		msg, err := g.fetchMessage(ctx, item.ID)
		if err != nil {
			return gmailState{}, err
		}
		if msg.ThreadID == "" {
			msg.ThreadID = item.ThreadID
		}
		msgs = append(msgs, msg)
	}
	return gmailState{
		Email:     profile.EmailAddress,
		HistoryID: profile.HistoryID,
		Messages:  msgs,
		Truncated: listed.NextPageToken != "" || len(listed.Messages) > gmailMaxMessages,
	}, nil
}

func (g *Gmail) fetchMessage(ctx context.Context, id string) (gmailMsg, error) {
	q := url.Values{}
	q.Set("format", "metadata")
	// format=full and format=raw return the body. Do not use them.
	q.Set("fields", "id,threadId,labelIds,snippet,internalDate,payload(headers)")
	q.Add("metadataHeaders", "Subject")
	q.Add("metadataHeaders", "From")
	q.Add("metadataHeaders", "To")
	q.Add("metadataHeaders", "Cc")
	q.Add("metadataHeaders", "Date")
	var resp struct {
		ID           string   `json:"id"`
		ThreadID     string   `json:"threadId"`
		LabelIDs     []string `json:"labelIds"`
		Snippet      string   `json:"snippet"`
		InternalDate string   `json:"internalDate"`
		Payload      struct {
			Headers []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"headers"`
		} `json:"payload"`
	}
	path := "/gmail/v1/users/me/messages/" + url.PathEscape(id)
	if err := g.client().getJSON(ctx, path, q, &resp); err != nil {
		return gmailMsg{}, err
	}
	msg := gmailMsg{
		ID:       resp.ID,
		ThreadID: resp.ThreadID,
		Snippet:  clipSnippet(resp.Snippet),
		Labels:   append([]string(nil), resp.LabelIDs...),
	}
	if msg.ID == "" {
		msg.ID = id
	}
	sort.Strings(msg.Labels)
	for _, h := range resp.Payload.Headers {
		switch strings.ToLower(h.Name) {
		case "subject":
			msg.Subject = h.Value
		case "from":
			msg.From = h.Value
		case "to":
			msg.To = h.Value
		case "cc":
			msg.Cc = h.Value
		case "date":
			if t, err := mailDate(h.Value); err == nil {
				msg.Date = t
			}
		}
	}
	if msg.Date.IsZero() && resp.InternalDate != "" {
		if ms, err := strconv.ParseInt(resp.InternalDate, 10, 64); err == nil {
			msg.Date = time.UnixMilli(ms).UTC()
		}
	}
	return msg, nil
}

type historyPage struct {
	History []struct {
		MessagesAdded []struct {
			Message struct {
				ID       string   `json:"id"`
				ThreadID string   `json:"threadId"`
				LabelIDs []string `json:"labelIds"`
			} `json:"message"`
		} `json:"messagesAdded"`
		MessagesDeleted []struct {
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
		} `json:"messagesDeleted"`
		LabelsAdded []struct {
			Message struct {
				ID       string   `json:"id"`
				LabelIDs []string `json:"labelIds"`
			} `json:"message"`
			LabelIDs []string `json:"labelIds"`
		} `json:"labelsAdded"`
		LabelsRemoved []struct {
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
			LabelIDs []string `json:"labelIds"`
		} `json:"labelsRemoved"`
	} `json:"history"`
	HistoryID     string `json:"historyId"`
	NextPageToken string `json:"nextPageToken"`
}

func (g *Gmail) applyHistory(ctx context.Context, snap gmailState) (gmailState, error) {
	current := map[string]gmailMsg{}
	order := make([]string, 0, len(snap.Messages))
	for _, msg := range snap.Messages {
		if msg.ID == "" {
			continue
		}
		if _, ok := current[msg.ID]; ok {
			continue
		}
		current[msg.ID] = msg
		order = append(order, msg.ID)
	}
	need := map[string]bool{}
	q := url.Values{}
	q.Set("startHistoryId", snap.HistoryID)
	q.Add("historyTypes", "messageAdded")
	q.Add("historyTypes", "messageDeleted")
	q.Add("historyTypes", "labelAdded")
	q.Add("historyTypes", "labelRemoved")
	historyID := snap.HistoryID
	for page := 0; page < 10; page++ {
		var resp historyPage
		if err := g.client().getJSON(ctx, "/gmail/v1/users/me/history", q, &resp); err != nil {
			return gmailState{}, err
		}
		if resp.HistoryID != "" {
			historyID = resp.HistoryID
		}
		for _, h := range resp.History {
			for _, del := range h.MessagesDeleted {
				delete(current, del.Message.ID)
			}
			for _, add := range h.MessagesAdded {
				id := add.Message.ID
				if id == "" {
					continue
				}
				msg := current[id]
				msg.ID = id
				if add.Message.ThreadID != "" {
					msg.ThreadID = add.Message.ThreadID
				}
				if len(add.Message.LabelIDs) > 0 {
					msg.Labels = append([]string(nil), add.Message.LabelIDs...)
					sort.Strings(msg.Labels)
				}
				if _, ok := current[id]; !ok {
					order = append(order, id)
					need[id] = true
				}
				current[id] = msg
			}
			for _, add := range h.LabelsAdded {
				id := add.Message.ID
				msg, ok := current[id]
				if !ok || id == "" {
					continue
				}
				msg.Labels = unionLabels(msg.Labels, add.LabelIDs)
				current[id] = msg
			}
			for _, rem := range h.LabelsRemoved {
				id := rem.Message.ID
				msg, ok := current[id]
				if !ok || id == "" {
					continue
				}
				msg.Labels = subtractLabels(msg.Labels, rem.LabelIDs)
				current[id] = msg
			}
		}
		if resp.NextPageToken == "" {
			break
		}
		q.Set("pageToken", resp.NextPageToken)
	}
	for id := range need {
		msg, err := g.fetchMessage(ctx, id)
		if err != nil {
			return gmailState{}, err
		}
		prev := current[id]
		if msg.ID == "" {
			msg.ID = id
		}
		if len(prev.Labels) > 0 && len(msg.Labels) == 0 {
			msg.Labels = prev.Labels
		}
		current[id] = msg
	}
	out := make([]gmailMsg, 0, len(order))
	for _, id := range order {
		msg, ok := current[id]
		if !ok {
			continue
		}
		out = append(out, msg)
	}
	return gmailState{Email: snap.Email, HistoryID: historyID, Messages: out}, nil
}

func diffGmail(before, after gmailState, cc lifediff.CompareContext) []lifediff.Change {
	prev := map[string]gmailMsg{}
	for _, msg := range before.Messages {
		if msg.ID != "" {
			prev[msg.ID] = msg
		}
	}
	next := map[string]gmailMsg{}
	for _, msg := range after.Messages {
		if msg.ID != "" {
			next[msg.ID] = msg
		}
	}
	ids := map[string]bool{}
	for id := range prev {
		ids[id] = true
	}
	for id := range next {
		ids[id] = true
	}
	order := make([]string, 0, len(ids))
	for id := range ids {
		order = append(order, id)
	}
	sort.Strings(order)
	suppressRemovals := before.Truncated || after.Truncated
	var changes []lifediff.Change
	for _, id := range order {
		old, had := prev[id]
		cur, has := next[id]
		switch {
		case had && !has:
			if suppressRemovals {
				continue
			}
			changes = append(changes, gmailChange(lifediff.KindRemoved, old, gmailMsg{}, after.Mode, cc))
		case !had && has:
			changes = append(changes, gmailChange(lifediff.KindAdded, gmailMsg{}, cur, after.Mode, cc))
		case had && has && gmailChanged(old, cur):
			changes = append(changes, gmailChange(lifediff.KindModified, old, cur, after.Mode, cc))
		}
	}
	return changes
}

func gmailChanged(before, after gmailMsg) bool {
	return before.Subject != after.Subject || before.From != after.From || before.To != after.To || before.Cc != after.Cc || before.Snippet != after.Snippet || !sameLabels(before.Labels, after.Labels)
}

type gmailAction string

const (
	gmailSent         gmailAction = "sent"
	gmailDrafted      gmailAction = "drafted"
	gmailDraftUpdated gmailAction = "draft-updated"
	gmailDeleted      gmailAction = "deleted"
	gmailArchived     gmailAction = "archived"
	gmailRelabeled    gmailAction = "relabeled"
	gmailReceived     gmailAction = "received"
)

func gmailChange(kind lifediff.ChangeKind, before, after gmailMsg, mode string, cc lifediff.CompareContext) lifediff.Change {
	msg := after
	if kind == lifediff.KindRemoved {
		msg = before
	}
	action := classifyGmail(kind, before, after)
	name := mailName(msg.Subject)
	ch := lifediff.Change{
		ID:           lifediff.ChangeID(lifediff.ServiceGmail, msg.ID, kind),
		Service:      lifediff.ServiceGmail,
		Kind:         kind,
		ResourceID:   msg.ID,
		ResourceName: name,
		Summary:      gmailSummary(action, kind, before, after),
		Fields:       gmailFields(kind, before, after),
		Link:         "https://mail.google.com/mail/u/0/#all/" + url.PathEscape(msg.ID),
		OccurredAt:   gmailWhen(msg.Date, mode, cc),
	}
	return ch
}

func classifyGmail(kind lifediff.ChangeKind, before, after gmailMsg) gmailAction {
	switch kind {
	case lifediff.KindRemoved:
		return gmailDeleted
	case lifediff.KindAdded:
		switch {
		case hasLabel(after.Labels, "SENT"):
			return gmailSent
		case hasLabel(after.Labels, "DRAFT"):
			return gmailDrafted
		default:
			return gmailReceived
		}
	case lifediff.KindModified:
		switch {
		case hasLabel(after.Labels, "TRASH") && !hasLabel(before.Labels, "TRASH"):
			return gmailDeleted
		case hasLabel(after.Labels, "SENT") && !hasLabel(before.Labels, "SENT"):
			return gmailSent
		case hasLabel(after.Labels, "DRAFT") && !hasLabel(before.Labels, "DRAFT"):
			return gmailDrafted
		case hasLabel(before.Labels, "INBOX") && !hasLabel(after.Labels, "INBOX") && !hasLabel(after.Labels, "TRASH"):
			return gmailArchived
		case hasLabel(before.Labels, "DRAFT") && hasLabel(after.Labels, "DRAFT") && (before.Subject != after.Subject || before.Snippet != after.Snippet):
			return gmailDraftUpdated
		default:
			return gmailRelabeled
		}
	default:
		panic(fmt.Sprintf("lifediff: unhandled change kind %q", kind))
	}
}

func gmailWhen(msgDate time.Time, mode string, cc lifediff.CompareContext) *time.Time {
	datedInSession := !msgDate.IsZero() && (cc.Session.StartedAt.IsZero() || !msgDate.Before(cc.Session.StartedAt))
	if datedInSession {
		t := msgDate.UTC()
		return &t
	}
	if mode == "history" && !cc.Session.CheckedAt.IsZero() {
		t := cc.Session.CheckedAt.UTC()
		return &t
	}
	if msgDate.IsZero() {
		return nil
	}
	t := msgDate.UTC()
	return &t
}

func gmailSummary(action gmailAction, kind lifediff.ChangeKind, before, after gmailMsg) string {
	msg := after
	if kind == lifediff.KindRemoved {
		msg = before
	}
	switch action {
	case gmailSent:
		return mailToLine("Sent "+quoteMail(msg.Subject), msg)
	case gmailDrafted:
		return mailToLine("Drafted "+quoteMail(msg.Subject), msg)
	case gmailDraftUpdated:
		return mailToLine("Updated draft "+quoteMail(msg.Subject), msg)
	case gmailDeleted:
		return "Deleted " + quoteMail(msg.Subject) + "."
	case gmailArchived:
		return "Archived " + quoteMail(msg.Subject) + "."
	case gmailRelabeled:
		return "Relabeled " + quoteMail(after.Subject) + " from " + labelText(before.Labels) + " to " + labelText(after.Labels) + "."
	case gmailReceived:
		line := "New email " + quoteMail(after.Subject)
		if after.From != "" {
			line += " from " + after.From
		}
		if to := recipientLine(after); to != "" {
			line += " to " + to
		}
		return line + "."
	default:
		panic(fmt.Sprintf("lifediff: unhandled gmail action %q", action))
	}
}

func mailToLine(lead string, msg gmailMsg) string {
	if to := recipientLine(msg); to != "" {
		return lead + " to " + to + "."
	}
	return lead + "."
}

func recipientLine(msg gmailMsg) string {
	var parts []string
	if strings.TrimSpace(msg.To) != "" {
		parts = append(parts, strings.TrimSpace(msg.To))
	}
	if strings.TrimSpace(msg.Cc) != "" {
		parts = append(parts, "cc "+strings.TrimSpace(msg.Cc))
	}
	return strings.Join(parts, "; ")
}

func gmailFields(kind lifediff.ChangeKind, before, after gmailMsg) []lifediff.FieldChange {
	var fields []lifediff.FieldChange
	switch kind {
	case lifediff.KindAdded, lifediff.KindRemoved, lifediff.KindModified:
	default:
		panic(fmt.Sprintf("lifediff: unhandled change kind %q", kind))
	}
	if before.Subject != "" || after.Subject != "" {
		fields = append(fields, mailField("subject", "Subject", before.Subject, after.Subject))
	}
	if before.From != "" || after.From != "" {
		fields = append(fields, mailField("from", "From", before.From, after.From))
	}
	if line := recipientLine(before); line != "" || recipientLine(after) != "" {
		fields = append(fields, mailField("recipients", "Recipients", recipientLine(before), recipientLine(after)))
	}
	if before.Snippet != "" || after.Snippet != "" {
		fields = append(fields, mailField("snippet", "Snippet", before.Snippet, after.Snippet))
	}
	if !sameLabels(before.Labels, after.Labels) && (len(before.Labels) > 0 || len(after.Labels) > 0) {
		fields = append(fields, mailField("labels", "Labels", labelText(before.Labels), labelText(after.Labels)))
	}
	if fields == nil {
		fields = []lifediff.FieldChange{}
	}
	return fields
}

func hasLabel(labels []string, want string) bool {
	for _, label := range labels {
		if label == want {
			return true
		}
	}
	return false
}

func clipSnippet(s string) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= 300 {
		return s
	}
	return string([]rune(s)[:300])
}

func mailField(field, label, before, after string) lifediff.FieldChange {
	return lifediff.FieldChange{Field: field, Label: label, Before: before, After: after}
}

func mailName(subject string) string {
	if strings.TrimSpace(subject) == "" {
		return "(no subject)"
	}
	return strings.TrimSpace(subject)
}

func quoteMail(subject string) string {
	return strconv.Quote(mailName(subject))
}

func labelText(labels []string) string {
	if len(labels) == 0 {
		return "none"
	}
	cp := append([]string(nil), labels...)
	sort.Strings(cp)
	return strings.Join(cp, ", ")
}

func sameLabels(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	aa := append([]string(nil), a...)
	bb := append([]string(nil), b...)
	sort.Strings(aa)
	sort.Strings(bb)
	for i := range aa {
		if aa[i] != bb[i] {
			return false
		}
	}
	return true
}

func unionLabels(have, add []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, label := range append(append([]string{}, have...), add...) {
		if label == "" || seen[label] {
			continue
		}
		seen[label] = true
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}

func subtractLabels(have, remove []string) []string {
	drop := map[string]bool{}
	for _, label := range remove {
		drop[label] = true
	}
	var out []string
	for _, label := range have {
		if drop[label] {
			continue
		}
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}

func mailDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, errors.New("empty date")
	}
	if t, err := time.Parse(time.RFC1123Z, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC1123, s)
}

func encode(v any) ([]byte, error) {
	return json.Marshal(v)
}

func decode(raw []byte, dest any) error {
	if len(raw) == 0 {
		return errors.New("gmail state is missing its payload")
	}
	return json.Unmarshal(raw, dest)
}
