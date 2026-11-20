package googleprov

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"time"

	"github.com/Cole-Z/life-diff"
)

const (
	calendarPageSize = "250"
	calendarMaxPages = 40
	calendarFields   = "items(id,summary,description,location,status,htmlLink,updated,start,end,attendees(email,responseStatus)),nextPageToken,nextSyncToken"
)

// Calendar reads events. It implements lifediff.CalendarReader.
type Calendar struct {
	Client *Client
}

var _ lifediff.CalendarReader = (*Calendar)(nil)

func (c *Calendar) client() *Client {
	if c != nil && c.Client != nil {
		return c.Client
	}
	return New(nil)
}

// ListWindow returns events in [start, end), including cancelled ones.
func (c *Calendar) ListWindow(ctx context.Context, calendarID string, start, end time.Time) ([]lifediff.CalendarEvent, error) {
	q := url.Values{}
	q.Set("singleEvents", "true")
	q.Set("showDeleted", "true")
	q.Set("orderBy", "startTime")
	q.Set("timeMin", start.UTC().Format(time.RFC3339))
	q.Set("timeMax", end.UTC().Format(time.RFC3339))
	q.Set("maxResults", calendarPageSize)
	q.Set("fields", calendarFields)
	events, _, err := c.list(ctx, calendarID, q, true)
	return events, err
}

// CurrentSyncToken pages a full event list until Google returns a sync token.
// The token is tied to singleEvents=true and showDeleted=true.
func (c *Calendar) CurrentSyncToken(ctx context.Context, calendarID string) (string, error) {
	q := url.Values{}
	q.Set("singleEvents", "true")
	q.Set("showDeleted", "true")
	q.Set("maxResults", calendarPageSize)
	q.Set("fields", "nextPageToken,nextSyncToken,items(id)")
	_, token, err := c.list(ctx, calendarID, q, false)
	if err != nil {
		return "", err
	}
	if token == "" {
		return "", fmt.Errorf("calendar list did not return a sync token")
	}
	return token, nil
}

// ListSyncChanges returns events changed since syncToken.
// Incremental requests send the sync token without the original time window.
func (c *Calendar) ListSyncChanges(ctx context.Context, calendarID, syncToken string) ([]lifediff.CalendarEvent, error) {
	q := url.Values{}
	q.Set("syncToken", syncToken)
	q.Set("maxResults", calendarPageSize)
	q.Set("fields", calendarFields)
	events, _, err := c.list(ctx, calendarID, q, false)
	return events, err
}

type calendarList struct {
	Items         []calendarEvent `json:"items"`
	NextPageToken string          `json:"nextPageToken"`
	NextSyncToken string          `json:"nextSyncToken"`
}

type calendarEvent struct {
	ID          string     `json:"id"`
	Summary     string     `json:"summary"`
	Description string     `json:"description"`
	Location    string     `json:"location"`
	Status      string     `json:"status"`
	HTMLLink    string     `json:"htmlLink"`
	Updated     string     `json:"updated"`
	Start       eventWhen  `json:"start"`
	End         eventWhen  `json:"end"`
	Attendees   []attendee `json:"attendees"`
}

type eventWhen struct {
	DateTime string `json:"dateTime"`
	Date     string `json:"date"`
	TimeZone string `json:"timeZone"`
}

type attendee struct {
	Email          string `json:"email"`
	ResponseStatus string `json:"responseStatus"`
}

func (c *Calendar) list(ctx context.Context, calendarID string, q url.Values, window bool) ([]lifediff.CalendarEvent, string, error) {
	if calendarID == "" {
		calendarID = "primary"
	}
	path := "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events"
	var all []lifediff.CalendarEvent
	pageToken := ""
	for page := 0; page < calendarMaxPages; page++ {
		if pageToken != "" {
			q.Set("pageToken", pageToken)
		} else {
			q.Del("pageToken")
		}
		var resp calendarList
		if err := c.client().getJSON(ctx, path, q, &resp); err != nil {
			return nil, "", err
		}
		for _, item := range resp.Items {
			ev, err := convertEvent(item)
			if err != nil {
				return nil, "", err
			}
			if ev.ID == "" {
				continue
			}
			all = append(all, ev)
		}
		if resp.NextPageToken == "" {
			return all, resp.NextSyncToken, nil
		}
		if resp.NextPageToken == pageToken {
			return nil, "", fmt.Errorf("calendar list repeated a page token")
		}
		pageToken = resp.NextPageToken
	}
	if window {
		return nil, "", lifediff.ErrTooManyEvents
	}
	return nil, "", fmt.Errorf("calendar list exceeded %d pages", calendarMaxPages)
}

func convertEvent(in calendarEvent) (lifediff.CalendarEvent, error) {
	ev := lifediff.CalendarEvent{
		ID:          in.ID,
		Summary:     in.Summary,
		Description: in.Description,
		Location:    in.Location,
		Status:      in.Status,
		Link:        in.HTMLLink,
	}
	var err error
	ev.Start, err = convertWhen(in.Start)
	if err != nil {
		return ev, fmt.Errorf("event %s start: %w", in.ID, err)
	}
	ev.End, err = convertWhen(in.End)
	if err != nil {
		return ev, fmt.Errorf("event %s end: %w", in.ID, err)
	}
	if in.Updated != "" {
		ev.Updated, err = parseGoogleTime(in.Updated)
		if err != nil {
			return ev, fmt.Errorf("event %s updated: %w", in.ID, err)
		}
	}
	for _, a := range in.Attendees {
		if a.Email == "" {
			continue
		}
		label := a.Email
		if a.ResponseStatus != "" {
			label += " (" + a.ResponseStatus + ")"
		}
		ev.Attendees = append(ev.Attendees, label)
	}
	sort.Strings(ev.Attendees)
	return ev, nil
}

func convertWhen(in eventWhen) (lifediff.EventTime, error) {
	if in.DateTime != "" {
		t, err := parseGoogleTime(in.DateTime)
		if err != nil {
			return lifediff.EventTime{}, err
		}
		return lifediff.EventTime{DateTime: t, TimeZone: in.TimeZone}, nil
	}
	return lifediff.EventTime{Date: in.Date, TimeZone: in.TimeZone}, nil
}
