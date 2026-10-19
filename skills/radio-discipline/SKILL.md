---
name: radio-discipline
description: Use whenever you send a message to another agent or session with SendMessage (agent teams, cross-session messages), and whenever you receive one. Every message starts with a call head or a reply head, so the sender can tell "will do", "cannot", "still working" and "no answer" apart.
---

# Radio discipline

Agents that message each other fail in quiet ways. A teammate starts working and never says it accepted. A teammate cannot do the job and keeps trying. A teammate dies and nobody notices. Air traffic control solved this with a small, fixed phraseology. Use it on every message you send to another agent.

The first line of every message is a **head**. A hook checks the head before the message leaves. If the head is wrong, the message is not sent and you get the reason. Fix the head and send again.

## 0. How messages arrive

Messages between agents are delivered **between turns**. While you are in the middle of a turn, nothing new reaches you.

- To wait for a call or a reply, **end your turn**. Do not wait inside a turn by reading files, polling the ledger or sleeping.
- A lead puts the work in the `[CALL]`, not in the spawn prompt. A good spawn prompt is: "Load the radio-discipline skill, then end your turn and wait for a call."

## 1. Making a call

```
[CALL] W/U Run the API tests and report the failures.
```

- `[CALL]` with no id. The hook assigns the next id (`R-7`) and tells you which one.
- Then the **attribute**: what kind of reply closes the call.
  - `W/U`: an instruction. Closed by `DONE` or `UNABLE`.
  - `A/N`: a yes/no question. Closed by `AFFIRM` or `NEGATIVE`.
  - `R`: information only. Closed by `ROGER`.
- One call asks for one thing. Put details on the lines after the head.

## 2. Answering a call

Answer **before you start the work**. The reply is the first thing you do.

| Head | Meaning | Closes the call? |
|---|---|---|
| `WILCO R-7` | I received it, understand it, and will do it | No. The work is now running. |
| `STANDBY R-7 — <why>` | I received it. I cannot answer yet. | No. It restarts the caller's timer. |
| `UNABLE R-7 — <reason>` | The goal was not reached and I cannot reach it. One line, with the reason. | Yes |
| `DONE R-7 — <result>` | The goal was reached. Details may follow on the next lines. | Yes |
| `AFFIRM R-7` / `NEGATIVE R-7` | Yes / no, for an `A/N` call | Yes |
| `ROGER R-7` | Received, for an `R` call | Yes |

- Use the id from the call you are answering. Never invent an id.
- Never answer a call with a new `[CALL]`. Answer it with one of the heads above and its id.
- `DONE` means the goal was reached, not that you ran the command. If you ran it and it failed, the answer is `UNABLE R-7 — <what failed>`.
- Say `UNABLE` early. Trying for a long time and then failing silently is the worst outcome.
- Answer a call once. Do not resend `DONE` because you were asked again or went idle; the caller already has it.
- During long work, send `STANDBY R-7 — <progress>` before the work timeout (15 minutes by default). That tells the caller you are alive.
- A message that is not an answer to a call is a new call: `[CALL] R …` for news, `[CALL] A/N …` or `[CALL] W/U …` for a request.

## 3. When nobody answers

The hook adds a note to your next send when one of your calls is overdue (no reply in 3 minutes, or no `DONE` or `STANDBY` in 15 minutes after `WILCO`). You can also run `node <plugin root>/bin/radio.mjs status`. This skill's folder is `<plugin root>/skills/radio-discipline`.

1. **First time overdue:** resend once with the same id and attribute: `[CALL R-7] W/U …`.
2. **Overdue again:** stop waiting. Tell the user, on a line of its own:
   `ESCALATE: R-7 to <name> — no reply after one resend`
   Then plan as if that agent is gone.

Do not resend more than once. Do not wait silently.

When you are about to go idle while calls you sent are open, the radio clock (a Stop hook) keeps you waiting until a message arrives or a call becomes overdue. If it stops you with an overdue note, do what the note says.

## 4. Filed documents (when the project turns on "filed")

Long work orders and reports do not go in messages. They live in a document table, and a message carries only a reference like `WO-3@a1b2c3` (the id and the first 6 hex digits of the text's hash).

- Read one: `node <plugin root>/bin/radio.mjs read WO-3@a1b2c3`
- File one: write it to a file, then `node <plugin root>/bin/radio.mjs file RPT "<title>" <file>`. It prints the reference.
- A call that carries a reference must be answered with that reference on the first line: `WILCO R-7 WO-3@a1b2c3`. That shows you read that exact version. The hook blocks a reply without it.
- Copy references exactly. A reference that is not in the table is blocked.

## 5. Turning it on

The hook does nothing until a project opts in:

```
node <plugin root>/bin/radio.mjs init            # enforce: bad heads are blocked
node <plugin root>/bin/radio.mjs init --mode log # log only: record, never block
```

This writes `.radio/config.json`. The ledger is `.radio/ledger.jsonl`: heads, ids, sizes and times, never message text. `radio.mjs stats` counts it.
