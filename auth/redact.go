package auth

import "regexp"

var (
	bearerRE = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`)
	jsonRE   = regexp.MustCompile(`(?i)"(access_token|refresh_token|client_secret|id_token)"\s*:\s*"[^"]*"`)
	formRE   = regexp.MustCompile(`(?i)\b(access_token|refresh_token|client_secret|id_token|code)=([^&\s"]+)`)
	ya29RE   = regexp.MustCompile(`ya29\.[0-9A-Za-z_-]+`)
)

// Redact removes Google tokens and client secrets from a string before it is logged.
func Redact(s string) string {
	s = bearerRE.ReplaceAllString(s, "Bearer [redacted]")
	s = jsonRE.ReplaceAllString(s, `"$1":"[redacted]"`)
	s = formRE.ReplaceAllString(s, "$1=[redacted]")
	s = ya29RE.ReplaceAllString(s, "[redacted]")
	return s
}
