# Changelog

## 0.1.2

- **A message that `SendMessage` did not deliver no longer counts as sent.** Before, a call to an agent that was not reachable was still recorded as an open call, so the radio clock held the session for the ack timeout, asked for a resend and then escalated a message that nobody received. Found in a live run: a call to `ghost` held the session about 3 minutes, then asked for a resend, then escalated after 3 more.
  - New `PostToolUse` hook `radio-undelivered` on `SendMessage`. When the result reports a failure (`success: false`, or an error result), it appends an `undelivered` line to the ledger with the call id, the head word for a reply, a reason class (`unreachable`, `rejected` or `error`) and the tool call id. It never stores the message text or the result text. It tells the model that the message was not delivered and does not count as sent.
  - `radio-check` records the `SendMessage` tool call id (`tool`) on each message line, so the two hooks match the same message.
  - The ledger leaves undelivered messages out: an undelivered call is not open, so the clock does not wait for it and no overdue note names it. An undelivered reply does not answer or close its call. An undelivered resend uses up no resend. A later resend with the same id that is delivered counts as the first send.
  - A message from another session that was not delivered does not end the clock's wait.
  - `radio.mjs stats` counts `undelivered` lines.

## 0.1.1

Fixes from an independent check of 0.1.0. Each has a regression test.

- **Privacy:** the `radio-unsent` Stop hook wrote the first 80 characters of an unsent head into `.radio/ledger.jsonl`, which broke the promise that the ledger never holds message text. It now records only the parsed head: kind, reply word, call id and attribute.
- **Overdue notes go only to the caller.** Every sender used to get notes about every overdue call. Now a session gets notes about the calls it sent, and a resend (`[CALL R-n]`) of another session's call is blocked (`not-your-call`), so it can no longer make the real caller skip its own resend and escalate.
- **The radio clock waits for real traffic.** Its wait used to end on any ledger line from another session, even a message that was blocked and never delivered. Blocked lines, unsent heads, clock lines and replies to other sessions' calls no longer end it.
- **Sessions in different folders can share a frequency.** A frequency is one `.radio` folder. `radio.mjs init --join <folder>` (config key `frequency`) or the `RADIO_DIR` environment variable puts a session in another folder on the same ledger. A reply with an unknown id now says that the caller may be on another frequency.
- **Escalated calls are retired.** The escalate note is given once, from the clock or on the caller's next send; after that the call is `escalated` and gets no more notes. A late reply still closes it or starts a new timer.
- The two Stop hooks run in parallel: `radio-clock` now returns at once when `radio-unsent` is blocking, so that message is not held back for minutes.
- `clockBudgetSec` is capped at 1140 s, below the hook's 1200 s timeout.
- `radio.mjs send` and `radio.mjs file` record the session from `RADIO_SESSION`, else `CLAUDE_CODE_SESSION_ID` (set by Claude Code), instead of `CLAUDE_SESSION_ID`, which Claude Code does not set. Calls sent this way are now the session's own calls for the clock. `send` also prints the overdue notes.
- `radio-unsent` removes markdown only at the edges of words, so `my_file.ts` and tokens keep their underscores.
- Heads with common punctuation are accepted: `WILCO R-1.`, `WILCO R-1, starting now`, `[CALL] W/U: Run the tests`. Near misses such as `**WILCO R-1**`, `Wilco R-1` or `WILCO R1` get a `near-head` reason that says what to change.
- CLI: `radio.mjs help` (also `-h`, `--help` and no command) prints the commands and exits 0; hints say `radio.mjs`, the name on the Bash tool's `PATH`.
- README: install steps that work for marketplace installs, a configuration table, the Stop hooks and how long the clock can wait, frequencies across folders, and which `.radio` files hold text.

## 0.1.0

First public release.

- Skill `radio-discipline`: call heads (`[CALL R-n]` with `W/U`, `A/N` or `R`) and reply heads (`WILCO`, `UNABLE`, `STANDBY`, `DONE`, `ROGER`, `AFFIRM`, `NEGATIVE`) for agents that message each other.
- `PreToolUse` hook on `SendMessage`: assigns call ids, blocks messages without a valid head, checks that replies name a real call and a word that fits it, and notes overdue calls (resend once, then escalate).
- `Stop` hooks: one blocks a stop when a turn wrote a radio head as text but sent no `SendMessage`; the other waits (capped) while the session's calls are open and, when one goes overdue, says to resend once or escalate.
- Ledger `.radio/ledger.jsonl` with heads, ids, sizes and times only, never message text.
- CLI `radio`: `init`, `status`, `stats`.
- Does nothing in a folder without `.radio/config.json`.
