# radio-discipline

Aviation-style radio discipline for Claude Code agents that message each other.

> Status: 0.1.2, unproven. The plugin works and is tested. Whether it makes teams of agents more reliable has not been measured yet, so nothing here claims an effect.

## The problem

When agents send each other work, they fail quietly:

- A teammate starts the work and never says it accepted it.
- A teammate cannot do the job and keeps trying.
- A teammate dies, and the lead waits forever.

From the lead's side, all three look the same: silence.

## The idea

Air traffic control has the same problem on a shared radio frequency and solved it with a small, fixed phraseology. Controller–pilot datalink (CPDLC) goes one step further: every message says which reply closes it, `STANDBY` keeps it open and restarts a timer, and a message with no reply in time is handed to voice. Models already know these words, so teaching them costs almost nothing.

```
lead → bob    [CALL R-7] W/U Run the API tests and report the failures.
bob → lead    WILCO R-7
bob → lead    STANDBY R-7 — suite is slow, about 8 more minutes
bob → lead    DONE R-7 — 212 passed, 2 failed (auth/refresh.test.ts)

lead → carol  [CALL R-8] W/U Rotate the payments key.
carol → lead  UNABLE R-8 — no PAYMENTS_API_KEY in this environment

lead → dave   [CALL R-9] W/U Update the changelog.
(no reply in 3 min)   → lead resends [CALL R-9] once
(no reply again)      → lead tells the user: ESCALATE: R-9 to dave — no reply after one resend
```

## What is in the plugin

- **A skill** ([skills/radio-discipline/SKILL.md](skills/radio-discipline/SKILL.md)): one page of rules for the lead and the teammates.
- **A `PreToolUse` hook on `SendMessage`** ([hooks/radio-check.mjs](hooks/radio-check.mjs)):
  - assigns call ids (`[CALL]` → `[CALL R-7]`);
  - blocks a message whose first line is not a valid head, and tells the model how to fix it;
  - checks that a reply uses a real id and a word that fits the call (`ROGER` cannot answer an instruction);
  - adds a note about your own overdue calls to the next message you send: resend once, then escalate. Only the session that sent a call may resend it.
- **A `PostToolUse` hook on `SendMessage`** ([hooks/radio-undelivered.mjs](hooks/radio-undelivered.mjs)): when `SendMessage` reports that it did not deliver a message (for example, no agent by that name is reachable), it marks the message undelivered in the ledger and tells the model. An undelivered call is not open: the clock does not wait for it and no overdue note names it. A resend with the same id that is delivered counts as the first send.
- **Two `Stop` hooks** (see [Stop hooks](#stop-hooks)): one catches a head written as text instead of sent; the other keeps a session with open calls waiting for the answers.
- **A ledger** (`.radio/ledger.jsonl`): heads, ids, sizes and times of every message. Never the text.
- **A small CLI** (`bin/radio.mjs`): `init`, `status`, `stats`, `help` and more.

The hooks do nothing in a folder without `.radio/config.json` (unless you set `RADIO_DIR`, see below), so installing the plugin does not change other projects.

## Install

Requirements: Node 22 or later, and Claude Code with agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) or cross-session messaging.

From GitHub:

```
/plugin marketplace add c10dev/radio-discipline-plugin
/plugin install radio-discipline@radio-discipline
```

Then turn it on in the project where your agents talk to each other. The hooks do nothing until `.radio/config.json` exists.

Inside Claude Code, the plugin's `bin/` folder is on the Bash tool's `PATH`, so ask Claude to run:

```bash
radio.mjs init        # or: radio.mjs init --mode log
```

From a terminal, run the CLI from the plugin cache. The last folder is the installed version, so it changes with each update (and `~/.claude` is `$CLAUDE_CONFIG_DIR` if you set that):

```bash
node ~/.claude/plugins/cache/radio-discipline/radio-discipline/0.1.2/bin/radio.mjs init
```

From a local clone, without installing:

```bash
claude --plugin-dir /path/to/radio-discipline
node /path/to/radio-discipline/bin/radio.mjs init
```

`radio.mjs help` lists every command.

## One frequency per ledger

A frequency is one `.radio` folder: its config, its ledger and its call ids. A session is on the frequency found in its working folder or the nearest parent folder, so sessions in one project and its subfolders (worktrees under `.claude/worktrees/` included) share one frequency.

Sessions in other folders are on another frequency, or on none. A reply from there to a call made here is blocked as "not a call on this frequency", or never reaches this ledger, and the call goes overdue although it was answered. To put another folder on the same frequency:

```bash
cd ../other-project
radio.mjs init --join ../your-project      # writes {"frequency": "/abs/path/your-project/.radio"}
```

For a session in a folder that should get no `.radio` at all, start Claude Code with `RADIO_DIR=/path/to/your-project` in its environment. `RADIO_DIR` wins over the folder search, so set it only for the sessions that belong on that frequency.

## Stop hooks

- **radio-unsent**: if a turn wrote a head (`DONE R-7 — …`) as text and sent no message, it blocks the stop once and tells the model to send it. Nobody reads an agent's terminal, so that reply never left.
- **radio-clock**: when a session is about to go idle while calls it sent are open, it keeps the session waiting. It checks the ledger at least every 3 seconds. The wait ends when a message that may be for this session arrives, or when one of its calls goes overdue (the hook then says to resend or to escalate), or after `clockBudgetSec`: 1080 seconds (18 minutes) by default and never more than 1140, because Claude Code gives the hook 1200. With the default timers a session whose teammate said `WILCO` and then went quiet sits in this wait for 15 minutes, until the work timeout. With the default budget no wait lasts longer than 18 minutes, and none longer than 19. That is the point: an idle agent has no timer of its own. Turn it off with `"clock": false`.

Claude Code runs both at once and waits for both. When radio-unsent blocks, radio-clock returns at once, so that message is not held back.

## Configuration

`.radio/config.json` is plain JSON. `radio.mjs init` writes the first three keys. If the file is not valid JSON, every `SendMessage` is blocked with the parse error until you fix or remove it.

| Key | Default | Effect |
|---|---|---|
| `mode` | `"enforce"` | `"enforce"` blocks a message without a valid head and tells the model why. `"log"` blocks nothing and records every message, so a team that writes plain English can be measured too. |
| `ackTimeoutSec` | `180` | A call with no reply is overdue this long after it was sent, resent, or answered with `STANDBY`. |
| `workTimeoutSec` | `900` | After `WILCO`, a call with no `DONE`, `UNABLE` or `STANDBY` is overdue after this. |
| `clock` | `true` | `false` turns off the radio-clock Stop hook. |
| `clockBudgetSec` | `1080` | The longest radio-clock wait, in seconds. Capped at 1140. |
| `unsent` | `true` | `false` turns off the radio-unsent Stop hook. |
| `filed` | `false` | `true` turns on filed documents: long work orders and reports live in `.radio/docs.jsonl`, messages carry a reference like `WO-3@a1b2c3`, and a reply must quote the reference of its call. |
| `push` | `false` | With `filed`, attach each referenced document to the message, so the receiver does not need `radio.mjs read`. |
| `debug` | `false` | `true` records the shape of each `SendMessage` input in `.radio/debug.jsonl`, including the first 80 characters of the message's first line. For trying the plugin out only. |
| `frequency` | none | Path of another folder with a radio (relative paths count from the folder that holds this `.radio`). When set, this folder uses that folder's config and ledger, and the other keys here are ignored. Written by `radio.mjs init --join`. |

Environment: `RADIO_DIR` (see above), and `RADIO_SESSION`, the session id that `radio.mjs send` and `radio.mjs file` record. It defaults to `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for its Bash tool, so calls sent with `radio.mjs send` are the session's own calls for the clock and the overdue notes.

## What is stored where

Everything is in the frequency's `.radio` folder. Only the ledger promises to hold no text.

| File | Holds | Message text? |
|---|---|---|
| `config.json` | the settings above | no |
| `ledger.jsonl` | one line per message: time, session, receiver, kind, head word, call id, attribute, document references, line and character counts, reject reason, and the id of the `SendMessage` tool call; one line per overdue note from the clock; one line per head written as text but not sent (its kind, word, id and attribute); one line per message that `SendMessage` did not deliver (its kind, word, id, tool call id and a reason class: `unreachable`, `rejected` or `error`) | never |
| `docs.jsonl` | filed documents (`radio.mjs file`), with their full text | yes, by design |
| `inbox.jsonl` | messages sent with `radio.mjs send`, for a script dispatcher to read | yes, by design |
| `debug.jsonl` | with `debug: true` only: the first 80 characters of each message's first line | yes, a few words |

The ledger names a receiver by the name the sender used, not by its session. So the hook cannot check that a reply comes from the agent the call was sent to.

## Where it comes from

[atc](https://github.com/c10dev/atc) runs teams of Claude Code sessions with an aviation phraseology and counts how they answer. Over nine days of its own logs (not published here), the most useful number was this: agents skip the acknowledgement 4% of the time on information-only calls and 20–41% of the time on work orders. They start working and forget to answer.

## Development

```bash
npm test
```

## License

Apache-2.0
