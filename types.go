package main

import "encoding/json"

type From struct {
	ID int64 `json:"id"`
	FirstName string `json:"first_name"`
}

type Chat struct {
	ID int64 `json:"id"`
}

// File is any Telegram file reference: a photo size, voice note, audio, document or video.
type File struct {
	FileID string `json:"file_id"`
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	FileSize int64 `json:"file_size"`
	FilePath string `json:"file_path"`
}

type Message struct {
	MessageID int `json:"message_id"`
	From *From `json:"from"`
	Chat *Chat `json:"chat"`
	Text string `json:"text"`
	Caption string `json:"caption"`
	Photo []File `json:"photo"`
	Voice *File `json:"voice"`
	Audio *File `json:"audio"`
	Document *File `json:"document"`
	Video *File `json:"video"`
	VideoNote *File `json:"video_note"`
}

// Stopped is sent when the user presses the stop button of a streamed draft.
type Stopped struct {
	Chat *Chat `json:"chat"`
	DraftID int64 `json:"draft_id"`
}

type Update struct {
	UpdateID int `json:"update_id"`
	Message *Message `json:"message"`
	Stopped *Stopped `json:"stopped_message_generation"`
}

// Resp is the envelope of every Telegram answer.
type Resp struct {
	Ok bool `json:"ok"`
	Result json.RawMessage `json:"result"`
	ErrorCode int `json:"error_code"`
	Description string `json:"description"`
	Parameters struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// Attachment is a file of a message, saved where the agent can read it. Error says why it could not be saved.
type Attachment struct {
	Kind string `json:"kind"`
	Path string `json:"path,omitempty"`
	Name string `json:"name"`
	Mime string `json:"mime,omitempty"`
	Size int64 `json:"size,omitempty"`
	Error string `json:"error,omitempty"`
}

// Inbound is what the agent gets for one update: a message, or a pressed stop button.
type Inbound struct {
	UpdateID int `json:"update_id"`
	ChatID int64 `json:"chat_id"`
	Text string `json:"text,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Stop bool `json:"stop,omitempty"`
}

// Outbound is what the agent posts to /send.
type Outbound struct {
	ChatID int64 `json:"chat_id"`
	Text string `json:"text"`
}

// Draft is what the agent posts to /draft while it works. Empty text shows a placeholder.
type Draft struct {
	ChatID int64 `json:"chat_id"`
	DraftID int64 `json:"draft_id"`
	Text string `json:"text"`
}

type Command struct {
	Command string `json:"command"`
	Description string `json:"description"`
}
