# Skills

Each chat keeps its skills in its Linux sandbox under `/workspace/.agents/skills/`. A skill is a directory containing `SKILL.md`, with optional scripts, references, and assets alongside it:

```text
/workspace/.agents/skills/
└── weekly-report/
    ├── SKILL.md
    ├── scripts/
    └── references/
```

Start `SKILL.md` with YAML frontmatter:

```markdown
---
name: weekly-report
description: Prepare a weekly report from the user's project files. Use when asked for a weekly update.
---

Read the project files and list completed work, unresolved issues, and next steps.
Read references/format.md for the report format. Resolve that path relative to this skill directory.
```

Ask Glav to create a skill at this path, or use its computer tools to copy an existing skill directory there. Files sent through Telegram are saved in `/workspace/inbox`; ask Glav to unpack or copy a skill into `.agents/skills`.

Before each model turn, Glav scans this directory and puts skill names, descriptions, and paths into a Pi Durable prompt section. Full instructions stay in `SKILL.md` until the model reads the relevant file with `read_file`. Creating, editing, or deleting a skill updates the catalog on the next turn without restarting or resetting the conversation.

Skills belong to the chat's sandbox and persist through its existing snapshot mechanism, including after `/new`. Hosted, self-hosted, and local Wrangler deployments use the same mechanism. The catalog is available only to chats with computer access. Discovery starts the sandbox when it is stopped.

Glav searches directories recursively until it finds `SKILL.md`, then treats that directory as one skill and skips its supporting directories. Hidden subdirectories and `node_modules` are skipped; directory symlinks are not traversed. Names must contain up to 64 lowercase letters, numbers, and hyphens. Descriptions must contain 1-1024 characters. A missing name falls back to the skill directory name. Invalid files and duplicate names produce Worker log warnings; the first discovered path wins for a duplicate.

Glav uses standard YAML frontmatter and supports quoted or multiline descriptions. `disable-model-invocation: true` hides a skill from automatic discovery in the model prompt. Glav does not currently implement Pi's `/skill:name` command; ask it to read the specific `SKILL.md` path to use such a skill explicitly. No executable extension is loaded from a skill directory.

Discovery reads only frontmatter, with a 16 KiB limit per header, and scans at most 200 skill files or 2000 directories per turn. The model's existing `read_file` and `bash` tools read the full instructions and run supporting scripts.
