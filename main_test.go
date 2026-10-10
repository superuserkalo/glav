package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

// telegram is a fake Bot API. answers maps a method to its response body; calls records each method called.
type telegram struct {
	*httptest.Server
	answers map[string]string
	calls []string
	forms map[string][]map[string]string
}

func newTelegram(t *testing.T, answers map[string]string) *telegram {
	tg := &telegram{answers: answers, forms: map[string][]map[string]string{}}
	tg.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/file/bot/") {
			fmt.Fprint(w, "file bytes")
			return
		}
		method := strings.TrimPrefix(r.URL.Path, "/bot/")
		form := map[string]string{}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			r.ParseMultipartForm(1 << 20)
			for k := range r.MultipartForm.Value {
				form[k] = r.FormValue(k)
			}
			for k, files := range r.MultipartForm.File {
				f, _ := files[0].Open()
				data, _ := io.ReadAll(f)
				form[k] = string(data)
			}
		} else {
			r.ParseForm()
			for k := range r.PostForm {
				form[k] = r.PostForm.Get(k)
			}
		}
		tg.calls = append(tg.calls, method)
		tg.forms[method] = append(tg.forms[method], form)
		if answer, ok := tg.answers[method]; ok {
			fmt.Fprint(w, answer)
			return
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(tg.Close)
	return tg
}

// agent is a fake agent that records what was forwarded to it.
type agent struct {
	*httptest.Server
	status int
	got []Inbound
	auth []string
}

func newAgent(t *testing.T) *agent {
	a := &agent{status: http.StatusOK}
	a.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in Inbound
		json.NewDecoder(r.Body).Decode(&in)
		a.got = append(a.got, in)
		a.auth = append(a.auth, r.Header.Get("Authorization"))
		w.WriteHeader(a.status)
	}))
	t.Cleanup(a.Close)
	return a
}

func newBot(t *testing.T, tg *telegram, a *agent) *bot {
	dir := t.TempDir()
	b := &bot{secret: "s3cret", apiBase: tg.URL + "/bot/", inboxDir: filepath.Join(dir, "inbox"), outboxDir: filepath.Join(dir, "outbox"), allowed: map[int64]bool{7: true}, turnedAway: map[int64]bool{}}
	if a != nil {
		b.agentUrl = a.URL
	}
	return b
}

func post(handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("POST", "/", strings.NewReader(body)))
	return rec
}

func TestSplitText(t *testing.T) {
	cases := map[string]string{
		"short": "hello",
		"exact": strings.Repeat("a", maxMessageLen),
		"long": strings.Repeat("a", maxMessageLen*2+10),
		"newlines": strings.Repeat(strings.Repeat("b", 99)+"\n", 100),
		"emoji": strings.Repeat("😀", maxMessageLen),
		"mixed": strings.Repeat("aж😀\n", 3000),
	}
	for name, text := range cases {
		parts := splitText(text, maxMessageLen)
		if strings.Join(parts, "") != text {
			t.Errorf("%s: parts do not join back to the text", name)
		}
		for i, part := range parts {
			if n := len(utf16.Encode([]rune(part))); n == 0 || n > maxMessageLen {
				t.Errorf("%s: part %d has %d UTF-16 units", name, i, n)
			}
		}
	}
	if parts := splitText("", maxMessageLen); len(parts) != 0 {
		t.Errorf("empty text gave %d parts", len(parts))
	}
	if parts := splitText(cases["newlines"], maxMessageLen); !strings.HasSuffix(parts[0], "\n") {
		t.Errorf("did not split at a newline")
	}
}

func TestSendHandler(t *testing.T) {
	cases := []struct {
		name string
		rich string
		want int
		retryAfter string
		calls string
	}{
		{"ok", `{"ok":true,"result":{}}`, http.StatusOK, "", "sendRichMessage"},
		{"blocked", `{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`, http.StatusUnprocessableEntity, "", "sendRichMessage sendMessage"},
		{"flood", `{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":7}}`, http.StatusServiceUnavailable, "7", "sendRichMessage"},
		{"server error", `{"ok":false,"error_code":500,"description":"Internal Server Error"}`, http.StatusBadGateway, "", "sendRichMessage"},
		{"garbage", `<html>`, http.StatusBadGateway, "", "sendRichMessage"},
	}
	for _, c := range cases {
		// A plain sendMessage gets the same refusal, so a permanent one stays permanent.
		tg := newTelegram(t, map[string]string{"sendRichMessage": c.rich, "sendMessage": c.rich})
		rec := post(newBot(t, tg, nil).sendHandler, `{"chat_id":42,"text":"**hi**"}`)

		if rec.Code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, rec.Code, c.want)
		}
		if got := rec.Header().Get("Retry-After"); got != c.retryAfter {
			t.Errorf("%s: Retry-After %q, want %q", c.name, got, c.retryAfter)
		}
		if got := strings.Join(tg.calls, " "); got != c.calls {
			t.Errorf("%s: called %q, want %q", c.name, got, c.calls)
		}
	}

	tg := newTelegram(t, nil)
	b := newBot(t, tg, nil)
	post(b.sendHandler, `{"chat_id":42,"text":"**hi**"}`)
	if got := tg.forms["sendRichMessage"][0]["rich_message"]; got != `{"markdown":"**hi**"}` {
		t.Errorf("rich_message = %s", got)
	}
	if rec := post(b.sendHandler, `{"text":"hi"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing chat_id: status %d, want 400", rec.Code)
	}
}

func TestSendFallsBackToPlainText(t *testing.T) {
	tg := newTelegram(t, map[string]string{
		"sendRichMessage": `{"ok":false,"error_code":400,"description":"Bad Request: can't parse rich message"}`,
	})
	text := strings.Repeat("a", maxMessageLen+1)
	rec := post(newBot(t, tg, nil).sendHandler, `{"chat_id":42,"text":"`+text+`"}`)

	if rec.Code != http.StatusOK {
		t.Errorf("status %d, want 200", rec.Code)
	}
	if got := strings.Join(tg.calls, " "); got != "sendRichMessage sendMessage sendMessage" {
		t.Errorf("called %q", got)
	}
}

func TestDraftHandler(t *testing.T) {
	tg := newTelegram(t, nil)
	b := newBot(t, tg, nil)

	post(b.draftHandler, `{"chat_id":42,"draft_id":3,"text":""}`)
	post(b.draftHandler, `{"chat_id":42,"draft_id":3,"text":"so far"}`)
	post(b.draftHandler, `{"chat_id":-100,"draft_id":3,"text":"so far"}`)

	if got := strings.Join(tg.calls, " "); got != "sendMessageDraft sendRichMessageDraft sendChatAction" {
		t.Errorf("called %q", got)
	}
	draft := tg.forms["sendRichMessageDraft"][0]
	if draft["draft_id"] != "3" || draft["can_stop"] != "true" || draft["rich_message"] != `{"markdown":"so far"}` {
		t.Errorf("draft form = %v", draft)
	}
	if rec := post(b.draftHandler, `{"chat_id":42}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing draft_id: status %d, want 400", rec.Code)
	}
}

func TestCommandsHandler(t *testing.T) {
	tg := newTelegram(t, nil)
	rec := post(newBot(t, tg, nil).commandsHandler, `[{"command":"new","description":"Start over"}]`)

	if rec.Code != http.StatusOK {
		t.Errorf("status %d, want 200", rec.Code)
	}
	if got := tg.forms["setMyCommands"][0]["commands"]; got != `[{"command":"new","description":"Start over"}]` {
		t.Errorf("commands = %s", got)
	}
}

func TestHandleForwardsOnlyAllowedUsers(t *testing.T) {
	tg := newTelegram(t, nil)
	a := newAgent(t)
	b := newBot(t, tg, a)

	message := func(from int64, chat int64, text string) Update {
		return Update{UpdateID: 1, Message: &Message{From: &From{ID: from}, Chat: &Chat{ID: chat}, Text: text}}
	}
	for _, u := range []Update{message(7, 7, "hi"), message(8, 8, "let me in"), message(8, 8, "again"), message(8, -100, "in a group")} {
		if err := b.handle(u); err != nil {
			t.Fatal(err)
		}
	}

	if len(a.got) != 1 || a.got[0].Text != "hi" || a.got[0].ChatID != 7 {
		t.Errorf("forwarded %+v", a.got)
	}
	// The stranger is told once, in private, and learns their ID.
	if len(tg.forms["sendMessage"]) != 1 || !strings.Contains(tg.forms["sendMessage"][0]["text"], "8") {
		t.Errorf("turn-away messages: %v", tg.forms["sendMessage"])
	}
}

func TestHandleStop(t *testing.T) {
	a := newAgent(t)
	b := newBot(t, newTelegram(t, nil), a)

	b.handle(Update{UpdateID: 5, Stopped: &Stopped{Chat: &Chat{ID: 7}, DraftID: 3}})
	b.handle(Update{UpdateID: 6, Stopped: &Stopped{Chat: &Chat{ID: 8}, DraftID: 3}})

	if len(a.got) != 1 || !a.got[0].Stop || a.got[0].ChatID != 7 {
		t.Errorf("forwarded %+v", a.got)
	}
}

func TestHandleKeepsUpdateWhenAgentFails(t *testing.T) {
	a := newAgent(t)
	a.status = http.StatusInternalServerError
	b := newBot(t, newTelegram(t, nil), a)
	u := Update{UpdateID: 1, Message: &Message{From: &From{ID: 7}, Chat: &Chat{ID: 7}, Text: "hi"}}

	if err := b.handle(u); err == nil {
		t.Errorf("a 500 from the agent counted as stored")
	}
	b.agentUrl = "http://127.0.0.1:1"
	if err := b.handle(u); err == nil {
		t.Errorf("an unreachable agent counted as stored")
	}
}

func TestHandleDownloadsAttachments(t *testing.T) {
	tg := newTelegram(t, map[string]string{"getFile": `{"ok":true,"result":{"file_path":"photos/file_1.jpg"}}`})
	a := newAgent(t)
	b := newBot(t, tg, a)

	err := b.handle(Update{UpdateID: 9, Message: &Message{
		From: &From{ID: 7}, Chat: &Chat{ID: 7}, Caption: "look",
		Photo: []File{{FileID: "small"}, {FileID: "large"}},
		Document: &File{FileID: "doc", FileName: "../../etc/my report?.pdf", MimeType: "application/pdf"},
	}})
	if err != nil {
		t.Fatal(err)
	}

	if len(a.got) != 1 || a.got[0].Text != "look" || len(a.got[0].Attachments) != 2 {
		t.Fatalf("forwarded %+v", a.got)
	}
	photo, doc := a.got[0].Attachments[0], a.got[0].Attachments[1]
	if photo.Kind != "photo" || photo.Mime != "image/jpeg" || tg.forms["getFile"][0]["file_id"] != "large" {
		t.Errorf("photo = %+v", photo)
	}
	if want := filepath.Join(b.inboxDir, "7", "9_1_my_report_.pdf"); doc.Path != want {
		t.Errorf("document path = %s, want %s", doc.Path, want)
	}
	for _, at := range a.got[0].Attachments {
		if data, _ := os.ReadFile(at.Path); string(data) != "file bytes" || at.Size != 10 {
			t.Errorf("%s: saved %q, size %d", at.Path, data, at.Size)
		}
	}
}

func TestHandleReportsFilesTelegramRefuses(t *testing.T) {
	tg := newTelegram(t, map[string]string{"getFile": `{"ok":false,"error_code":400,"description":"Bad Request: file is too big"}`})
	a := newAgent(t)
	b := newBot(t, tg, a)

	err := b.handle(Update{UpdateID: 9, Message: &Message{From: &From{ID: 7}, Chat: &Chat{ID: 7}, Video: &File{FileID: "big"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(a.got) != 1 || len(a.got[0].Attachments) != 1 {
		t.Fatalf("forwarded %+v", a.got)
	}
	if at := a.got[0].Attachments[0]; at.Path != "" || !strings.Contains(at.Error, "too big") {
		t.Errorf("attachment = %+v", at)
	}
}

func TestHandleRetriesFailedDownload(t *testing.T) {
	tg := newTelegram(t, map[string]string{"getFile": `{"ok":false,"error_code":500,"description":"Internal Server Error"}`})
	a := newAgent(t)
	b := newBot(t, tg, a)

	err := b.handle(Update{UpdateID: 9, Message: &Message{From: &From{ID: 7}, Chat: &Chat{ID: 7}, Voice: &File{FileID: "v"}}})
	if err == nil || len(a.got) != 0 {
		t.Errorf("err = %v, forwarded %+v", err, a.got)
	}
}

func TestFetchUpdates(t *testing.T) {
	tg := newTelegram(t, map[string]string{"getUpdates": `{"ok":true,"result":[{"update_id":3,"message":{"text":"hi","from":{"id":7},"chat":{"id":7}}},{"update_id":4,"stopped_message_generation":{"chat":{"id":7},"draft_id":2}}]}`})
	updates, err := newBot(t, tg, nil).fetchUpdates(3)
	if err != nil || len(updates) != 2 || updates[0].Message.Text != "hi" || updates[1].Stopped.DraftID != 2 {
		t.Errorf("updates = %+v, err = %v", updates, err)
	}
	if got := tg.forms["getUpdates"][0]["offset"]; got != "3" {
		t.Errorf("offset = %s", got)
	}

	tg.answers["getUpdates"] = `{"ok":false,"error_code":401,"description":"Unauthorized"}`
	if _, err := newBot(t, tg, nil).fetchUpdates(0); err == nil {
		t.Errorf("ok=false counted as success")
	}
}

func TestSharedSecret(t *testing.T) {
	tg := newTelegram(t, nil)
	a := newAgent(t)
	b := newBot(t, tg, a)
	send := func(header string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/send", strings.NewReader(`{"chat_id":42,"text":"hi"}`))
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		b.authorized(b.sendHandler)(rec, req)
		return rec.Code
	}

	if got := send(""); got != http.StatusUnauthorized {
		t.Errorf("no secret: status %d, want 401", got)
	}
	if got := send("Bearer wrong"); got != http.StatusUnauthorized {
		t.Errorf("wrong secret: status %d, want 401", got)
	}
	if len(tg.calls) != 0 {
		t.Errorf("an unauthorized request reached Telegram: %v", tg.calls)
	}
	if got := send("Bearer s3cret"); got != http.StatusOK {
		t.Errorf("right secret: status %d, want 200", got)
	}

	b.handle(Update{UpdateID: 1, Message: &Message{From: &From{ID: 7}, Chat: &Chat{ID: 7}, Text: "hi"}})
	if len(a.auth) != 1 || a.auth[0] != "Bearer s3cret" {
		t.Errorf("forwarded with Authorization %q", a.auth)
	}
}

func TestVoiceHandler(t *testing.T) {
	tg := newTelegram(t, nil)
	b := newBot(t, tg, nil)
	os.MkdirAll(b.outboxDir, 0o700)
	voice := filepath.Join(b.outboxDir, "a.ogg")
	os.WriteFile(voice, []byte("opus bytes"), 0o600)
	secret := filepath.Join(filepath.Dir(b.outboxDir), "secret.txt")
	os.WriteFile(secret, []byte("private"), 0o600)
	body := func(path string) string {
		data, _ := json.Marshal(Voice{ChatID: 42, Path: path, Caption: "what I said"})
		return string(data)
	}

	if rec := post(b.voiceHandler, body(voice)); rec.Code != http.StatusOK {
		t.Errorf("status %d, want 200", rec.Code)
	}
	if form := tg.forms["sendVoice"][0]; form["chat_id"] != "42" || form["voice"] != "opus bytes" || form["caption"] != "what I said" {
		t.Errorf("sendVoice form = %v", form)
	}
	for _, path := range []string{secret, filepath.Join(b.outboxDir, "..", "secret.txt"), "/etc/passwd", filepath.Join(b.outboxDir, "missing.ogg")} {
		if rec := post(b.voiceHandler, body(path)); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", path, rec.Code)
		}
	}
	if len(tg.calls) != 1 {
		t.Errorf("Telegram calls: %v", tg.calls)
	}
}
