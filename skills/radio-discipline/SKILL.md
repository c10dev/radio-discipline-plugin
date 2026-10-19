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

The hook adds a note to your next send when one of your calls is overdue (no reply in 3 minutes, or no `DONE` or `STANDBY` in 15 minutes after `WILCO`). You can also run `radio.mjs status` (or `node <plugin root>/bin/radio.mjs status`). This skill's folder is `<plugin root>/skills/radio-discipline`.

1. **First time overdue:** resend once with the same id and attribute: `[CALL R-7] W/U …`. Only the session that sent a call resends it; the hook blocks a resend of someone else's call.
2. **Overdue again:** stop waiting. Tell the user, on a line of its own:
   `ESCALATE: R-7 to <name> — no reply after one resend`
   Then plan as if that agent is gone.

Do not resend more than once. Do not wait silently.

If `SendMessage` says it did not deliver a message (for example, no agent by that name is reachable), the message does not count as sent: the clock does not wait for it and it uses up no resend. Check the receiver's name and send it again with the same id (`[CALL R-7] W/U …`, or the same reply head), or tell the user.

You are told to escalate once. After that the call is retired: no more notes, and the clock no longer waits for it. If the agent answers late, its reply still counts: `DONE` or `UNABLE` closes the call, and `WILCO` or `STANDBY` starts a new timer.

When you are about to go idle while calls you sent are open, the radio clock (a Stop hook) keeps you waiting until a message arrives or a call becomes overdue (18 minutes at most by default). If it stops you with an overdue note, do what the note says.

## 3a. Other folders

A frequency is one `.radio` folder. Sessions working in other folders are on another frequency unless that folder was joined with `radio.mjs init --join <folder>`. If the hook blocks your reply because the id "is not a call on this frequency" and you copied the id from the call you received, the caller is in another folder: tell the user, and do not invent a new id.

## 4. Filed documents (when the project turns on "filed")

Long work orders and reports do not go in messages. They live in a document table, and a message carries only a reference like `WO-3@a1b2c3` (the id and the first 6 hex digits of the text's hash).

- Read one: `radio.mjs read WO-3@a1b2c3`
- File one: write it to a file, then `radio.mjs file RPT "<title>" <file>`. It prints the reference.
- A call that carries a reference must be answered with that reference on the first line: `WILCO R-7 WO-3@a1b2c3`. That shows you read that exact version. The hook blocks a reply without it.
- Copy references exactly. A reference that is not in the table is blocked.

## 5. Turning it on

The hook does nothing until a project opts in:

```
radio.mjs init                 # enforce: bad heads are blocked
radio.mjs init --mode log      # log only: record, never block
radio.mjs init --join <folder> # share the frequency of another folder
```

`radio.mjs` is the plugin's `bin/radio.mjs`; the Bash tool finds it on its `PATH`, or run `node <plugin root>/bin/radio.mjs`. This writes `.radio/config.json`. The ledger is `.radio/ledger.jsonl`: heads, ids, sizes and times, never message text. `radio.mjs stats` counts it.
