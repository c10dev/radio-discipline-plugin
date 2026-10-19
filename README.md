# radio-discipline

Aviation-style radio discipline for Claude Code agents that message each other.

> Status: 0.1.0, unproven. The plugin works and is tested. Whether it makes teams of agents more reliable has not been measured yet, so nothing here claims an effect.

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
  - adds a note about overdue calls to the next message sent: resend once, then escalate.
- **A ledger** (`.radio/ledger.jsonl`): heads, ids, sizes and times of every message. Never the text.
- **A small CLI** (`bin/radio.mjs`): `init`, `status`, `stats`.

The hook does nothing in a folder without `.radio/config.json`, so installing the plugin does not change other projects.

## Install

Requirements: Node 22 or later, and Claude Code with agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) or cross-session messaging.

From GitHub (replace `<owner>/<repo>` with where this repository lives):

```
/plugin marketplace add <owner>/<repo>
/plugin install radio-discipline@radio-discipline
```

Then turn it on in the project where your agents talk to each other. The hook does nothing until this file exists:

```bash
cd your-project
node /path/to/radio-discipline/bin/radio.mjs init        # or: init --mode log
```

From a local clone, without installing:

```bash
claude --plugin-dir /path/to/radio-discipline
```

## Where it comes from

[atc](https://github.com/c10dev/atc) runs teams of Claude Code sessions with an aviation phraseology and counts how they answer. Over nine days of its own logs (not published here), the most useful number was this: agents skip the acknowledgement 4% of the time on information-only calls and 20–41% of the time on work orders. They start working and forget to answer.

## Development

```bash
npm test
```

## License

Apache-2.0
