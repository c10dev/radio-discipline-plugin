# Changelog

## 0.1.0

First public release.

- Skill `radio-discipline`: call heads (`[CALL R-n]` with `W/U`, `A/N` or `R`) and reply heads (`WILCO`, `UNABLE`, `STANDBY`, `DONE`, `ROGER`, `AFFIRM`, `NEGATIVE`) for agents that message each other.
- `PreToolUse` hook on `SendMessage`: assigns call ids, blocks messages without a valid head, checks that replies name a real call and a word that fits it, and notes overdue calls (resend once, then escalate).
- `Stop` hooks: one blocks a stop when a turn wrote a radio head as text but sent no `SendMessage`; the other waits (capped) while the session's calls are open and, when one goes overdue, says to resend once or escalate.
- Ledger `.radio/ledger.jsonl` with heads, ids, sizes and times only, never message text.
- CLI `radio`: `init`, `status`, `stats`.
- Does nothing in a folder without `.radio/config.json`.
