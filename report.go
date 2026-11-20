package lifediff

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
	"time"
)

// RenderHTML returns a self-contained HTML report for a receipt.
func RenderHTML(r Receipt) ([]byte, error) {
	var buf bytes.Buffer
	if err := reportTmpl.Execute(&buf, reportView(r)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

type viewData struct {
	ID         string
	Session    string
	Headline   string
	Services   []viewSection
	Claims     []viewClaim
	ShowClaims bool
	Notes      []string
	Warnings   []string
	Empty      bool
}

type viewSection struct {
	Name    string
	Intro   string
	Changes []viewCard
	Empty   string
}

type viewCard struct {
	Kind             string
	KindLabel        string
	Summary          string
	Confidence       string
	ConfidenceReason string
	Claim            string
	Link             string
	Fields           []viewField
}

type viewField struct {
	Label  string
	Before string
	After  string
	Single bool
	Value  string
}

type viewClaim struct {
	Status     string
	StatusText string
	Title      string
	Reason     string
	Detail     string
}

func reportView(r Receipt) viewData {
	loc := loadLocation(r.TimeZone)
	v := viewData{
		ID:         r.ID,
		Session:    sessionLine(r, loc),
		Headline:   headline(r.Counts),
		ShowClaims: r.ClaimsChecked,
		Notes:      r.Notes,
		Warnings:   r.Warnings,
		Empty:      len(r.Changes) == 0,
	}
	if len(r.Providers) > 0 {
		for _, p := range r.Providers {
			name := p.DisplayName
			if name == "" {
				name = Service(p.ID).Display()
			}
			v.Services = append(v.Services, viewSectionNamed(name, p.Intro, Service(p.ID), r))
		}
	} else {
		if r.Calendar != nil {
			v.Services = append(v.Services, viewSectionFor(ServiceCalendar, r, calendarIntro(r, loc)))
		}
		if r.Drive != nil {
			v.Services = append(v.Services, viewSectionFor(ServiceDrive, r, driveIntro(r)))
		}
	}
	for _, c := range r.Claims {
		item := viewClaim{
			Status:     string(c.Status),
			StatusText: c.Status.Display(),
			Title:      claimTitle(c),
			Reason:     c.Reason,
			Detail:     c.Detail,
		}
		v.Claims = append(v.Claims, item)
	}
	return v
}

func viewSectionFor(service Service, r Receipt, intro string) viewSection {
	return viewSectionNamed(service.Display(), intro, service, r)
}

func viewSectionNamed(name, intro string, service Service, r Receipt) viewSection {
	sec := viewSection{Name: name, Intro: intro}
	for _, ch := range r.Changes {
		if ch.Service != service {
			continue
		}
		sec.Changes = append(sec.Changes, viewCardFrom(ch))
	}
	if len(sec.Changes) == 0 {
		sec.Empty = "No " + strings.ToLower(service.Display()) + " changes."
	}
	return sec
}

func viewCardFrom(ch Change) viewCard {
	card := viewCard{
		Kind:             string(ch.Kind),
		KindLabel:        ch.Kind.Display(),
		Summary:          ch.Summary,
		Confidence:       ch.Confidence.Display(),
		ConfidenceReason: ch.ConfidenceReason,
		Link:             safeLink(ch.Link),
	}
	switch ch.ClaimStatus {
	case ClaimVerified:
		card.Claim = "The agent claimed this."
	case ClaimUnclaimed:
		card.Claim = "The agent did not claim this."
	case ClaimMissing, "":
		card.Claim = ""
	default:
		panic(fmt.Sprintf("lifediff: unhandled claim status %q", ch.ClaimStatus))
	}
	for _, f := range ch.Fields {
		if strings.TrimSpace(f.Before) == "" && strings.TrimSpace(f.After) == "" {
			continue
		}
		field := viewField{Label: f.Label, Before: f.Before, After: f.After}
		switch ch.Kind {
		case KindAdded:
			field.Single = true
			field.Value = f.After
			if field.Value == "" {
				field.Value = f.Before
			}
		case KindRemoved:
			field.Single = true
			field.Value = f.Before
			if field.Value == "" {
				field.Value = f.After
			}
		case KindModified:
			field.Single = false
		default:
			panic(fmt.Sprintf("lifediff: unhandled change kind %q", ch.Kind))
		}
		if field.Single && strings.TrimSpace(field.Value) == "" {
			continue
		}
		card.Fields = append(card.Fields, field)
	}
	return card
}

func sessionLine(r Receipt, loc *time.Location) string {
	return "Snapshot " + formatInstant(r.Session.StartedAt, loc) + " · checked " + formatInstant(r.Session.CheckedAt, loc)
}

func headline(c Counts) string {
	return fmt.Sprintf("%d added, %d removed, %d modified", c.Added, c.Removed, c.Modified)
}

func calendarIntro(r Receipt, loc *time.Location) string {
	if r.Calendar == nil {
		return ""
	}
	return "Events from " + formatInstant(r.Calendar.WindowStart, loc) + " to " + formatInstant(r.Calendar.WindowEnd, loc) + "."
}

func driveIntro(r Receipt) string {
	if r.Drive == nil {
		return ""
	}
	if r.Drive.DiffMode == DriveDiffChanges {
		return "File details compared with Drive's change history since the snapshot."
	}
	return "File details compared by listing Drive again."
}

func claimTitle(c ClaimResult) string {
	action := c.Action
	if action == "" {
		action = "change"
	}
	where := "Google"
	if c.Service != "" {
		where = c.Service.Display()
	}
	return fmt.Sprintf("%s %s in %s", c.Status.Display(), quoteName(c.Target), where) + " (" + action + ")"
}

var reportTmpl = template.Must(template.New("report").Parse(reportHTML))

const reportHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Life Diff receipt {{.ID}}</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: #f3efe6;
    --ink: #1c1915;
    --muted: #5c564c;
    --card: #fffdf8;
    --line: #e4dccd;
    --mast: #1e3a32;
    --mast-ink: #f6f1e7;
    --added: #0f5c32;
    --added-bg: #e7f6ec;
    --removed: #8d1c1c;
    --removed-bg: #fdeeee;
    --modified: #6b4300;
    --modified-bg: #fff6e4;
    --neutral: #3f3a33;
    --neutral-bg: #efeae1;
    --focus: #1e3a32;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #161310;
      --ink: #f4efe6;
      --muted: #c2b8a8;
      --card: #221e1a;
      --line: #3a332c;
      --mast: #10241e;
      --mast-ink: #f6f1e7;
      --added: #9ddec0;
      --added-bg: #143226;
      --removed: #f3b4ae;
      --removed-bg: #3a1717;
      --modified: #f0cb86;
      --modified-bg: #3a2c14;
      --neutral: #f4efe6;
      --neutral-bg: #2a251f;
      --focus: #f0cb86;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 16px/1.5 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  main { max-width: 880px; margin: 0 auto; padding: 0 20px 64px; }
  header.mast {
    background: var(--mast);
    color: var(--mast-ink);
    padding: 28px 20px 22px;
  }
  header.mast .wrap { max-width: 880px; margin: 0 auto; }
  .word { font-family: Georgia, "Iowan Old Style", Palatino, serif; font-size: 34px; margin: 0; letter-spacing: -0.03em; }
  .lede { margin: 6px 0 0; color: #d9e6df; }
  .session { margin: 14px 0 0; font-size: 14px; }
  .headline { margin: 18px 0 0; font-size: 18px; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .badge, .tag {
    display: inline-flex; align-items: center; gap: 6px;
    border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 650;
    border: 1px solid transparent;
  }
  .badge svg, .tag svg { width: 14px; height: 14px; display: block; }
  .badge-added { background: var(--added-bg); color: var(--added); }
  .badge-removed { background: var(--removed-bg); color: var(--removed); }
  .badge-modified { background: var(--modified-bg); color: var(--modified); }
  .tag { background: var(--neutral-bg); color: var(--neutral); font-weight: 600; }
  section { margin-top: 28px; }
  h2 { font-family: Georgia, Palatino, serif; font-size: 26px; margin: 0 0 4px; }
  .intro { margin: 0 0 12px; color: var(--muted); }
  article.change {
    background: var(--card);
    border: 1px solid var(--line);
    border-left-width: 8px;
    border-radius: 12px;
    padding: 14px 16px 12px;
    margin: 12px 0;
  }
  article.is-added { border-left-color: var(--added); }
  article.is-removed { border-left-color: var(--removed); }
  article.is-modified { border-left-color: var(--modified); }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  h3 { font-family: Georgia, Palatino, serif; font-size: 20px; line-height: 1.35; font-weight: 600; margin: 0 0 10px; }
  .fields { display: grid; gap: 8px; margin: 0 0 8px; }
  .field { display: grid; grid-template-columns: 7.5rem 1fr; gap: 8px; align-items: baseline; }
  .field .label { color: var(--muted); font-size: 13px; }
  .compare { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .before, .after, .value {
    background: var(--neutral-bg);
    border-radius: 8px;
    padding: 4px 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .arrow { color: var(--muted); }
  .why, .empty, .note, .warn { color: var(--muted); margin: 4px 0; }
  .warn { color: var(--modified); }
  a { color: var(--focus); }
  footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
  .claims article { border-left-color: var(--neutral); }
  .claims article.is-verified { border-left-color: var(--added); }
  .claims article.is-missing { border-left-color: var(--modified); }
  @media (max-width: 640px) {
    .field { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <p class="word">Life Diff</p>
    <p class="lede">A read-only receipt of what changed in your Google accounts.</p>
    <p class="session">{{.Session}}</p>
    <p class="headline">{{.Headline}}</p>
    <div class="legend" aria-label="Legend">
      <span class="badge badge-added">{{template "icon-added"}} Added</span>
      <span class="badge badge-removed">{{template "icon-removed"}} Removed</span>
      <span class="badge badge-modified">{{template "icon-modified"}} Modified</span>
    </div>
  </div>
</header>
<main>
  {{range .Services}}
  <section>
    <h2>{{.Name}}</h2>
    {{if .Intro}}<p class="intro">{{.Intro}}</p>{{end}}
    {{if .Empty}}<p class="empty">{{.Empty}}</p>{{end}}
    {{range .Changes}}
    <article class="change is-{{.Kind}}">
      <div class="meta">
        <span class="badge badge-{{.Kind}}">{{template "icon" .}}{{.KindLabel}}</span>
        <span class="tag">{{.Confidence}}</span>
        {{if .Claim}}<span class="tag">{{.Claim}}</span>{{end}}
      </div>
      <h3>{{.Summary}}</h3>
      {{if .Fields}}
      <div class="fields">
        {{range .Fields}}
        <div class="field">
          <div class="label">{{.Label}}</div>
          <div>
            {{if .Single}}
              <span class="value">{{.Value}}</span>
            {{else}}
              <div class="compare">
                <span class="before">{{.Before}}</span>
                <span class="arrow" aria-hidden="true">→</span>
                <span class="after">{{.After}}</span>
              </div>
            {{end}}
          </div>
        </div>
        {{end}}
      </div>
      {{end}}
      <p class="why">{{.ConfidenceReason}}</p>
      {{if .Link}}<p><a href="{{.Link}}">Open in Google</a></p>{{end}}
    </article>
    {{end}}
  </section>
  {{end}}

  {{if .ShowClaims}}
  <section class="claims">
    <h2>What the agent said</h2>
    <p class="intro">Each claim is marked verified when Google shows a matching change, or missing when it does not.</p>
    {{if not .Claims}}<p class="empty">The agent claimed that nothing changed.</p>{{end}}
    {{range .Claims}}
    <article class="change is-{{.Status}}">
      <div class="meta">
        <span class="badge {{if eq .Status "verified"}}badge-added{{else}}badge-modified{{end}}">
          {{if eq .Status "verified"}}{{template "icon-verified"}}{{else}}{{template "icon-missing"}}{{end}}
          {{.StatusText}}
        </span>
      </div>
      <h3>{{.Title}}</h3>
      {{if .Detail}}<p>{{.Detail}}</p>{{end}}
      <p class="why">{{.Reason}}</p>
    </article>
    {{end}}
  </section>
  {{end}}

  {{if .Warnings}}
  <section>
    <h2>Check notes</h2>
    {{range .Warnings}}<p class="warn">{{.}}</p>{{end}}
  </section>
  {{end}}

  <section>
    <h2>How to read this</h2>
    {{range .Notes}}<p class="note">{{.}}</p>{{end}}
  </section>
  <footer>Receipt {{.ID}} · schema 1.0.0 · Life Diff did not change any Google data.</footer>
</main>
</body>
</html>

{{define "icon"}}
  {{if eq .Kind "added"}}{{template "icon-added"}}{{else if eq .Kind "removed"}}{{template "icon-removed"}}{{else}}{{template "icon-modified"}}{{end}}
{{end}}
{{define "icon-added"}}<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 1h2v14H7zM1 7h14v2H1z"/></svg>{{end}}
{{define "icon-removed"}}<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 7h14v2H1z"/></svg>{{end}}
{{define "icon-modified"}}<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M12.1 1.4l2.5 2.5-8.2 8.2H3.9V9.6l8.2-8.2zM2 14h12v1.5H2z"/></svg>{{end}}
{{define "icon-verified"}}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.2l3.2 3.2 7.3-7.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>{{end}}
{{define "icon-missing"}}<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.8"/></svg>{{end}}
`
