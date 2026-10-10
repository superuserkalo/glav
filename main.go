package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/joho/godotenv"
)

// Telegram's limits for one plain and one rich message. The plain one counts UTF-16 code units.
const maxMessageLen = 4096
const maxRichLen = 30000

// Long enough to outlast the 30s long poll.
var client = &http.Client{Timeout: 45 * time.Second}

type bot struct {
	apiBase string
	agentUrl string
	inboxDir string
	// The only place voice files to send may come from.
	outboxDir string
	// Shared with the agent. Both sides refuse a request without it, so nothing else on this machine, a web page in a
	// browser included, can pose as the other.
	secret string
	// Telegram IDs that may use the bot: users, and group chats they may use it in. Empty means nobody.
	allowed map[int64]bool
	// Strangers who were already told they are not allowed.
	turnedAway map[int64]bool
}

func main() {

	err := godotenv.Load(".env")
	if err != nil {
		log.Fatal("Error loading .env file")
	}

	baseUrl := "https://api.telegram.org/bot"
	token := os.Getenv("telegram_key")

	inboxDir, err := filepath.Abs(envOr("inbox_dir", "agent/data/workspace/inbox"))
	if err != nil {
		log.Fatal(err)
	}

	secret := os.Getenv("agent_secret")
	if secret == "" {
		log.Fatal("agent_secret is not set in .env. Generate one with: openssl rand -hex 32")
	}

	b := &bot{
		secret: secret,
		apiBase: baseUrl + token + "/",
		agentUrl: "http://" + envOr("agent_addr", "127.0.0.1:8787") + "/inbound",
		inboxDir: inboxDir,
		outboxDir: filepath.Join(filepath.Dir(inboxDir), "outbox"),
		allowed: parseAllowed(os.Getenv("allowed_users")),
		turnedAway: map[int64]bool{},
	}
	if len(b.allowed) == 0 {
		log.Println("allowed_users is empty: nobody can use the bot. Message it to learn your user ID.")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /send", b.authorized(b.sendHandler))
	mux.HandleFunc("POST /draft", b.authorized(b.draftHandler))
	mux.HandleFunc("POST /voice", b.authorized(b.voiceHandler))
	mux.HandleFunc("POST /commands", b.authorized(b.commandsHandler))
	go func() {
		log.Fatal(http.ListenAndServe(envOr("send_addr", "127.0.0.1:8788"), mux))
	}()

	b.getUpdate()
}

func envOr(key string, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// authorized lets a request through only with the shared secret.
func (b *bot) authorized(next http.HandlerFunc) http.HandlerFunc {
	want := []byte("Bearer " + b.secret)
	return func(w http.ResponseWriter, r *http.Request) {
		if b.secret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func parseAllowed(list string) map[int64]bool {
	allowed := map[int64]bool{}
	for _, field := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ' ' }) {
		id, err := strconv.ParseInt(field, 10, 64)
		if err != nil {
			log.Fatalf("allowed_users: %q is not a numeric Telegram user ID", field)
		}
		allowed[id] = true
	}
	return allowed
}

// sendError is a Telegram refusal. Permanent ones can never succeed on a retry.
type sendError struct {
	Permanent bool
	RetryAfter int
	Description string
}

func (e *sendError) Error() string {
	return e.Description
}

func permanent(err error) bool {
	var se *sendError
	return errors.As(err, &se) && se.Permanent
}

// call runs one Bot API method and returns its result.
func (b *bot) call(method string, values url.Values) (json.RawMessage, error) {
	return b.request(method, "application/x-www-form-urlencoded", strings.NewReader(values.Encode()))
}

func (b *bot) request(method string, contentType string, body io.Reader) (json.RawMessage, error) {
	resp, err := client.Post(b.apiBase+method, contentType, body)
	if err != nil {
		// The error carries the request URL, which holds the bot token.
		return nil, errors.New("telegram unreachable")
	}
	defer resp.Body.Close()

	var r Resp
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("decode %s response (status %d): %w", method, resp.StatusCode, err)
	}
	if r.Ok {
		return r.Result, nil
	}
	return nil, &sendError{
		Permanent: r.ErrorCode == 400 || r.ErrorCode == 403,
		RetryAfter: r.Parameters.RetryAfter,
		Description: fmt.Sprintf("telegram %d: %s", r.ErrorCode, r.Description),
	}
}

func richMessage(markdown string) string {
	rich, _ := json.Marshal(map[string]string{"markdown": markdown})
	return string(rich)
}

// sendMessage sends Markdown as a rich message, and as plain text when Telegram cannot take it that way.
func (b *bot) sendMessage(chatID int64, text string) error {
	chat := strconv.FormatInt(chatID, 10)
	_, err := b.call("sendRichMessage", url.Values{"chat_id": {chat}, "rich_message": {richMessage(text)}})
	if !permanent(err) {
		return err
	}
	log.Println("sendRichMessage refused, sending plain text:", err)
	for _, part := range splitText(text, maxMessageLen) {
		if _, err := b.call("sendMessage", url.Values{"chat_id": {chat}, "text": {part}}); err != nil {
			return err
		}
	}
	return nil
}

// splitText cuts text into pieces of at most limit UTF-16 code units, at a newline when one is close enough.
func splitText(text string, limit int) []string {
	var parts []string
	for len(text) > 0 {
		end, units, lastNewline := 0, 0, -1
		for end < len(text) {
			r, size := utf8.DecodeRuneInString(text[end:])
			n := 1
			if r > 0xFFFF {
				n = 2
			}
			if units+n > limit {
				break
			}
			units += n
			end += size
			if r == '\n' {
				lastNewline = end
			}
		}
		if end < len(text) && lastNewline > end/2 {
			end = lastNewline
		}
		parts = append(parts, text[:end])
		text = text[end:]
	}
	return parts
}

// refuse answers 422 when Telegram never will take the request, and 502 or 503 to ask for a retry.
func refuse(w http.ResponseWriter, err error) {
	var se *sendError
	switch {
	case errors.As(err, &se) && se.Permanent:
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
	case errors.As(err, &se) && se.RetryAfter > 0:
		w.Header().Set("Retry-After", strconv.Itoa(se.RetryAfter))
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
}

// sendHandler answers 200 once Telegram took the whole message.
func (b *bot) sendHandler(w http.ResponseWriter, r *http.Request) {
	var out Outbound
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil || out.ChatID == 0 || out.Text == "" {
		http.Error(w, "expected chat_id and text", http.StatusBadRequest)
		return
	}
	for _, part := range splitText(out.Text, maxRichLen) {
		if err := b.sendMessage(out.ChatID, part); err != nil {
			log.Println("sendMessage error:", err)
			refuse(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}

// draftHandler shows work in progress: a streamed draft with a stop button in private chats, "typing" elsewhere.
func (b *bot) draftHandler(w http.ResponseWriter, r *http.Request) {
	var d Draft
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil || d.ChatID == 0 || d.DraftID == 0 {
		http.Error(w, "expected chat_id and draft_id", http.StatusBadRequest)
		return
	}
	chat := strconv.FormatInt(d.ChatID, 10)
	values := url.Values{"chat_id": {chat}, "draft_id": {strconv.FormatInt(d.DraftID, 10)}, "can_stop": {"true"}}

	var err error
	switch {
	case d.ChatID < 0:
		// Drafts exist only in private chats.
		_, err = b.call("sendChatAction", url.Values{"chat_id": {chat}, "action": {"typing"}})
	case d.Text == "":
		_, err = b.call("sendMessageDraft", values)
	default:
		parts := splitText(d.Text, maxRichLen)
		values.Set("rich_message", richMessage(parts[len(parts)-1]))
		_, err = b.call("sendRichMessageDraft", values)
	}
	if err != nil {
		refuse(w, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// voiceHandler sends a file from the outbox as a voice message.
func (b *bot) voiceHandler(w http.ResponseWriter, r *http.Request) {
	var v Voice
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil || v.ChatID == 0 || v.Path == "" {
		http.Error(w, "expected chat_id and path", http.StatusBadRequest)
		return
	}
	rel, err := filepath.Rel(b.outboxDir, filepath.Clean(v.Path))
	if err != nil || !filepath.IsLocal(rel) {
		http.Error(w, "path is outside the outbox", http.StatusBadRequest)
		return
	}
	// Opened through a root, so a symlink in the outbox cannot lead to a file outside it either.
	root, err := os.OpenRoot(b.outboxDir)
	if err != nil {
		http.Error(w, "cannot open the outbox", http.StatusBadRequest)
		return
	}
	defer root.Close()
	file, err := root.Open(rel)
	if err != nil {
		http.Error(w, "cannot read the voice file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	audio, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "cannot read the voice file", http.StatusBadRequest)
		return
	}

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	form.WriteField("chat_id", strconv.FormatInt(v.ChatID, 10))
	if v.Caption != "" {
		form.WriteField("caption", v.Caption)
	}
	part, _ := form.CreateFormFile("voice", "voice.ogg")
	part.Write(audio)
	form.Close()
	if _, err := b.request("sendVoice", form.FormDataContentType(), &body); err != nil {
		log.Println("sendVoice error:", err)
		refuse(w, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// commandsHandler publishes the agent's commands in Telegram's menu.
func (b *bot) commandsHandler(w http.ResponseWriter, r *http.Request) {
	var commands []Command
	if err := json.NewDecoder(r.Body).Decode(&commands); err != nil {
		http.Error(w, "expected a list of commands", http.StatusBadRequest)
		return
	}
	list, _ := json.Marshal(commands)
	if _, err := b.call("setMyCommands", url.Values{"commands": {string(list)}}); err != nil {
		refuse(w, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// forward hands one update to the agent. Only a 2xx means the agent stored it.
func (b *bot) forward(in Inbound) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", b.agentUrl, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.secret)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("agent answered %d", resp.StatusCode)
	}
	return nil
}

// files lists what a message carries, the largest size of a photo only.
func files(m *Message) []Attachment {
	var list []Attachment
	add := func(kind string, f *File, name string) {
		if f == nil {
			return
		}
		if f.FileName != "" {
			name = f.FileName
		}
		list = append(list, Attachment{Kind: kind, Path: f.FileID, Name: name, Mime: f.MimeType, Size: f.FileSize})
	}
	if len(m.Photo) > 0 {
		add("photo", &m.Photo[len(m.Photo)-1], "photo.jpg")
		list[len(list)-1].Mime = "image/jpeg"
	}
	add("voice", m.Voice, "voice.ogg")
	add("audio", m.Audio, "audio.mp3")
	add("document", m.Document, "file")
	add("video", m.Video, "video.mp4")
	add("video", m.VideoNote, "video_note.mp4")
	return list
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// download saves an attachment under the inbox and replaces its file ID by the saved path. A file Telegram will never
// hand out, such as one over its 20MB limit, keeps the message going with the reason in Error.
func (b *bot) download(a *Attachment, chatID int64, prefix string) error {
	fileID := a.Path
	a.Path = ""

	result, err := b.call("getFile", url.Values{"file_id": {fileID}})
	if permanent(err) {
		a.Error = err.Error()
		return nil
	}
	if err != nil {
		return err
	}
	var f File
	if err := json.Unmarshal(result, &f); err != nil || f.FilePath == "" {
		return fmt.Errorf("getFile gave no file path")
	}

	resp, err := client.Get(strings.Replace(b.apiBase, "/bot", "/file/bot", 1) + f.FilePath)
	if err != nil {
		// The error carries the request URL, which holds the bot token.
		return errors.New("telegram unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("file download answered %d", resp.StatusCode)
	}

	dir := filepath.Join(b.inboxDir, strconv.FormatInt(chatID, 10))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := strings.Trim(unsafeName.ReplaceAllString(filepath.Base(a.Name), "_"), ".")
	path := filepath.Join(dir, prefix+"_"+name)
	tmp, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, resp.Body)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	a.Path = path
	a.Size = size
	return nil
}

// handle deals with one update. An error means it has to be handled again.
func (b *bot) handle(u Update) error {
	if u.Stopped != nil && u.Stopped.Chat != nil {
		// Drafts exist only in private chats, where the chat ID is the user's ID.
		if !b.allowed[u.Stopped.Chat.ID] {
			return nil
		}
		return b.forward(Inbound{UpdateID: u.UpdateID, ChatID: u.Stopped.Chat.ID, Stop: true})
	}

	m := u.Message
	if m == nil || m.Chat == nil || m.From == nil {
		return nil
	}
	// The sender has to be allowed, and so does the place: answers go to the chat, where everyone in it reads them.
	// A private chat has its user's ID. A group has to be listed itself.
	if !b.allowed[m.From.ID] || !b.allowed[m.Chat.ID] {
		b.turnAway(m)
		return nil
	}

	in := Inbound{UpdateID: u.UpdateID, ChatID: m.Chat.ID, Text: m.Text, Attachments: files(m)}
	if in.Text == "" {
		in.Text = m.Caption
	}
	if in.Text == "" && len(in.Attachments) == 0 {
		return nil
	}
	for i := range in.Attachments {
		prefix := strconv.Itoa(u.UpdateID)
		if i > 0 {
			prefix += "_" + strconv.Itoa(i)
		}
		if err := b.download(&in.Attachments[i], m.Chat.ID, prefix); err != nil {
			return fmt.Errorf("download: %w", err)
		}
	}
	return b.forward(in)
}

// turnAway tells a stranger once, in private, how to get access.
func (b *bot) turnAway(m *Message) {
	if b.turnedAway[m.From.ID] {
		return
	}
	b.turnedAway[m.From.ID] = true
	log.Printf("turned away user %d (%s) in chat %d", m.From.ID, m.From.FirstName, m.Chat.ID)
	if m.Chat.ID != m.From.ID {
		return
	}
	text := fmt.Sprintf("This bot is private. Your Telegram user ID is %d. Its owner can let you in by adding that ID to allowed_users.", m.From.ID)
	if _, err := b.call("sendMessage", url.Values{"chat_id": {strconv.FormatInt(m.Chat.ID, 10)}, "text": {text}}); err != nil {
		log.Println("sendMessage error:", err)
	}
}

// fetchUpdates long-polls Telegram. Asking for an offset confirms every update below it.
func (b *bot) fetchUpdates(offset int) ([]Update, error) {
	result, err := b.call("getUpdates", url.Values{
		"timeout": {"30"},
		"offset": {strconv.Itoa(offset)},
		"allowed_updates": {`["message","stopped_message_generation"]`},
	})
	if err != nil {
		return nil, err
	}
	var updates []Update
	if err := json.Unmarshal(result, &updates); err != nil {
		return nil, fmt.Errorf("decode error: %w", err)
	}
	return updates, nil
}

func (b *bot) getUpdate() {
	offset := 0
	backoff := time.Second

	// Pending updates come back at once, so every failure has to wait before the next poll.
	retry := func(what string, err error) {
		log.Printf("%s: %v, retrying in %s", what, err, backoff)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}

	for {
		updates, err := b.fetchUpdates(offset)
		if err != nil {
			retry("getUpdates error", err)
			continue
		}

		for _, u := range updates {
			if err := b.handle(u); err != nil {
				// Stop here: moving the offset past this update would lose the message.
				retry("update "+strconv.Itoa(u.UpdateID), err)
				break
			}
			offset = u.UpdateID + 1
			backoff = time.Second
		}
	}
}
