package lifediff

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ParseClaims accepts either {"claims":[...]} or a bare JSON array.
func ParseClaims(data []byte) ([]ClaimInput, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return []ClaimInput{}, nil
	}
	if data[0] == '[' {
		var claims []ClaimInput
		if err := json.Unmarshal(data, &claims); err != nil {
			return nil, fmt.Errorf("read claims: %w", err)
		}
		return validateClaims(claims)
	}
	var wrap struct {
		Claims []ClaimInput `json:"claims"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		return nil, fmt.Errorf("read claims: %w", err)
	}
	return validateClaims(wrap.Claims)
}

func validateClaims(claims []ClaimInput) ([]ClaimInput, error) {
	if claims == nil {
		claims = []ClaimInput{}
	}
	for i, c := range claims {
		if strings.TrimSpace(c.Target) == "" {
			return nil, fmt.Errorf("claim %d is missing a target name", i+1)
		}
		if _, err := normalizeClaim(c); err != nil {
			return nil, fmt.Errorf("claim %d: %w", i+1, err)
		}
	}
	return claims, nil
}

type normalizedClaim struct {
	raw     ClaimInput
	service Service
	action  ChangeKind
	anyKind bool
}

func normalizeClaim(c ClaimInput) (normalizedClaim, error) {
	out := normalizedClaim{raw: c, anyKind: true}
	if s := strings.TrimSpace(c.Service); s != "" {
		svc, err := canonicalService(s)
		if err != nil {
			return out, err
		}
		out.service = svc
	}
	if a := strings.TrimSpace(c.Action); a != "" {
		kind, err := normalizeAction(a)
		if err != nil {
			return out, err
		}
		out.action = kind
		out.anyKind = false
	}
	return out, nil
}

func normalizeAction(action string) (ChangeKind, error) {
	switch fold(action) {
	case "add", "added", "create", "created", "new":
		return KindAdded, nil
	case "remove", "removed", "delete", "deleted", "trash", "trashed":
		return KindRemoved, nil
	case "modify", "modified", "update", "updated", "change", "changed", "edit", "edited", "move", "moved", "rename", "renamed":
		return KindModified, nil
	default:
		return "", fmt.Errorf("unknown action %q (use added, removed, or modified)", action)
	}
}

type claimPair struct {
	ci, chi, score int
}

func applyClaims(r *Receipt, inputs []ClaimInput) {
	if inputs == nil {
		inputs = []ClaimInput{}
	}
	claims := make([]normalizedClaim, 0, len(inputs))
	for _, in := range inputs {
		n, err := normalizeClaim(in)
		if err != nil {
			// ParseClaims rejects this. BuildReceipt still keeps the claim visible.
			claims = append(claims, normalizedClaim{raw: in})
			continue
		}
		claims = append(claims, n)
	}

	var pairs []claimPair
	for ci, claim := range claims {
		if strings.TrimSpace(claim.raw.Target) == "" {
			continue
		}
		for chi := range r.Changes {
			if s := scoreClaim(claim, r.Changes[chi]); s > 0 {
				pairs = append(pairs, claimPair{ci: ci, chi: chi, score: s})
			}
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].score != pairs[j].score {
			return pairs[i].score > pairs[j].score
		}
		if pairs[i].ci != pairs[j].ci {
			return pairs[i].ci < pairs[j].ci
		}
		return pairs[i].chi < pairs[j].chi
	})

	usedClaim := map[int]bool{}
	usedChange := map[int]bool{}
	match := map[int]int{}
	for _, p := range pairs {
		if usedClaim[p.ci] || usedChange[p.chi] {
			continue
		}
		usedClaim[p.ci] = true
		usedChange[p.chi] = true
		match[p.ci] = p.chi
	}

	results := make([]ClaimResult, 0, len(claims))
	for i, claim := range claims {
		id := claim.raw.ID
		if id == "" {
			id = fmt.Sprintf("claim-%d", i+1)
		}
		result := ClaimResult{
			ID:      id,
			Service: claim.service,
			Target:  claim.raw.Target,
			Detail:  claim.raw.Detail,
		}
		if !claim.anyKind {
			result.Action = string(claim.action)
		}
		if chi, ok := match[i]; ok {
			ch := r.Changes[chi]
			result.Status = ClaimVerified
			result.MatchedChangeIDs = []string{ch.ID}
			result.Confidence = ch.Confidence
			result.Reason = verifiedReason(ch)
			r.Changes[chi].ClaimStatus = ClaimVerified
		} else {
			result.Status = ClaimMissing
			result.Reason = missingReason(claim.service)
		}
		results = append(results, result)
	}
	for i := range r.Changes {
		if r.Changes[i].ClaimStatus == "" {
			r.Changes[i].ClaimStatus = ClaimUnclaimed
		}
	}
	r.Claims = results
}

func scoreClaim(claim normalizedClaim, ch Change) int {
	if claim.service != "" && claim.service != ch.Service {
		return 0
	}
	if !claim.anyKind && claim.action != ch.Kind {
		return 0
	}
	target := fold(claim.raw.Target)
	if target == "" {
		return 0
	}
	score := 0
	switch {
	case claim.raw.Target == ch.ResourceID:
		score = 12
	case target == fold(ch.ResourceName):
		score = 10
	case phraseIn(ch.ResourceName, claim.raw.Target) || phraseIn(claim.raw.Target, ch.ResourceName):
		score = 6
	default:
		return 0
	}
	if detail := fold(claim.raw.Detail); detail != "" && phraseIn(ch.Summary, claim.raw.Detail) {
		score += 2
	}
	return score
}

func phraseIn(hay, needle string) bool {
	h := fold(hay)
	n := fold(needle)
	if len([]rune(n)) < 3 {
		return false
	}
	if h == n {
		return true
	}
	return strings.Contains(" "+h+" ", " "+n+" ")
}

func verifiedReason(ch Change) string {
	reason := fmt.Sprintf("This matches a %s change to %s.", ch.Service.Display(), quoteName(ch.ResourceName))
	if ch.Confidence == ConfidenceLow {
		reason += " The service dates that change before the snapshot, so this check is less sure the agent did it."
	}
	return reason
}

func canonicalService(s string) (Service, error) {
	switch fold(s) {
	case "calendar", "gcal", "google calendar", "google-calendar":
		return ServiceCalendar, nil
	case "drive", "gdrive", "google drive", "google-drive":
		return ServiceDrive, nil
	case "gmail", "google mail", "google-mail":
		return ServiceGmail, nil
	default:
		id := strings.TrimSpace(fold(s))
		if validProviderID(id) {
			return Service(id), nil
		}
		return "", fmt.Errorf("unknown service %q", s)
	}
}

func missingReason(service Service) string {
	switch service {
	case ServiceCalendar:
		return "No matching change showed up in Calendar."
	case ServiceDrive:
		return "No matching change showed up in Drive."
	case ServiceGmail:
		return "No matching change showed up in Gmail."
	case "":
		return "No matching change showed up."
	default:
		return fmt.Sprintf("No matching change showed up in %s.", service.Display())
	}
}
