# TODO

## Durable storage for documents and memory

- [ ] Make user documents and filesystem memory persist independently of the sandbox and its snapshots.

Snapshot renewal is the temporary retention mechanism. Important user data must remain recoverable even if renewal stops, a snapshot expires, or the container image changes. Keep renewal enabled until migration and recovery are verified.

Acceptance criteria:

- Define which workspace paths contain durable user data, including uploaded documents, generated files, memory, and user configuration; separate rebuildable caches and dependencies.
- Store those files in independent durable storage, with isolation between chats. Evaluate R2 and record storage, request, and recovery costs before choosing the implementation.
- Define when filesystem changes become durable. A failed or interrupted save must preserve the last complete version, and the agent must not claim a file is durably saved before storage confirms it.
- Recover the files into a fresh sandbox without the old snapshot or container image. Verify file contents and permissions.
- Migrate existing workspaces, verify the durable copies, and retain the existing recovery path until migration succeeds.
- Provide versioned recovery for accidental overwrite or deletion, with an explicit retention policy and failed-save alerts.
- Test sandbox loss, expired snapshots, image upgrades, interrupted writes, unavailable storage, and recovery of a previous version.
