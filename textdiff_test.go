package lifediff

import "testing"

func TestTextEditSentenceQuotesASmallChange(t *testing.T) {
	got := textEditSentence("Vacation ideas (final)", "Lisbon\nTokyo\nLaunch TBD\n", "Lisbon\nTokyo\nLaunch in May\n", false)
	want := `Updated the text of "Vacation ideas (final)": removed "Launch TBD" and added "Launch in May".`
	if got != want {
		t.Fatal(got)
	}
	before, after := textFieldPair("Lisbon\nLaunch TBD\n", "Lisbon\nLaunch in May\n")
	if before != "Lisbon\nLaunch TBD" || after != "Lisbon\nLaunch in May" {
		t.Fatalf("%q -> %q", before, after)
	}
}

func TestTextEditSentenceCountsALongChange(t *testing.T) {
	var before, after string
	for i := 0; i < 10; i++ {
		before += "old line\n"
		after += "new line\n"
	}
	got := textEditSentence("Notes", before, after, true)
	want := `Updated the text of "Notes" (10 lines added, 10 lines removed). The stored text was cut off.`
	if got != want {
		t.Fatal(got)
	}
}

func TestDriveTextKind(t *testing.T) {
	if DriveTextKind("application/vnd.google-apps.document") != "document" {
		t.Fatal("doc")
	}
	if DriveTextKind("application/vnd.google-apps.spreadsheet") != "spreadsheet" {
		t.Fatal("sheet")
	}
	if DriveTextKind("application/vnd.google-apps.presentation") != "presentation" {
		t.Fatal("slides")
	}
	if DriveTextKind("text/plain") != "plain" || DriveTextKind("image/jpeg") != "" {
		t.Fatal("plain or image")
	}
}
