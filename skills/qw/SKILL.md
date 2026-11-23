---
name: qw
description: Tell the queue coordinator to open a worker now. /qw <task> starts one worker for the task, /qw N <task> splits the work between N workers, /qw <session name>: <task> sends the task to that open session and relays its answer. Use when the user types /qw.
argument-hint: "[N | session name:] <task>"
---

`/qw` is typed in the coordinator session, followed by the task text. It skips the normal
reading of a message: the user has already decided that this is new work and how it runs.
`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root.

If this session is not the coordinator: when `Q lock status` prints `LOCKED`, send the whole
`/qw ...` line to the coordinator with SendMessage (find it with ListAgents; it is named
`Queue Coordinator <nickname>`) and say so in one line. Otherwise tell the user to start
`/queue-start` first, and stop.

## Reading the arguments

Look at the text after `/qw`, in this order:

1. **Nothing after it.** Ask what the work is.
2. **A number.** The first word is a whole number from 1 to 20 and more text follows: that
   number is N and the rest is the task. `/qw 1 <task>` is the same as `/qw <task>`.
3. **A session name.** The text starts with the name of an open session, followed by a colon
   or the end of the first line: `/qw ops: check the disk on the api host`. Call ListAgents
   and compare the names case-insensitively; the longest name that matches wins. Everything
   after the colon is the task. If the text before the first colon is short (six words or
   fewer, on the first line) and matches no open session, it may be a session that is closed
   or misspelled: show what ListAgents lists and ask whether it is a session or part of the
   task.
4. **Anything else** is task text for one worker.

To start a task with a number or a colon without it being read as N or a session, put `--`
first: `/qw -- 3 pages break on mobile`.

## Where the work goes, when no session is named

For `/qw <task>` and each part of `/qw N <task>`, starting a new worker is the default. Send
the work elsewhere instead when that fits better:

- **To a running worker**, when it is already on the same page or files, so the work does not
  collide or get explored twice: send it with SendMessage and add it under that task's prompt
  as `Also: <text>`.
- **To an open session, as a one-off helper request** (as in "A session" below), when the work
  needs access or context only that session has, such as production access, which workers
  never have.

Say in the one line where the work went and why ("sent to the running worker on Billing page
totals: same file", "sent to session ops: needs server access"), so the user can overrule it.
If they do, start a new worker for it after all.

## One worker: `/qw <task>`

Unless it goes elsewhere (above), add one task to `queue.md`, as for new work, but put it
before every waiting task so it is the next to start, and start its worker now. If the text
names a `[held]` task already in `queue.md`, start that one instead of adding a copy: remove
its `[held]` tag and move it first. "First" always means after the `[notes]` block, which
stays at the top. Say in the line if it overlaps a running task.

`max_workers` still holds. If no slot is free, say it waits and for which running task. The
`one_at_a_time` and dependency rules of the coordinator also still hold; say if one of them
makes it wait.

## N workers: `/qw N <task>`

Split the work into N tasks that can run side by side: each one complete on its own, with its
own title and prompt, and as few shared files as possible. Keep the user's words; each prompt
says which part it covers and names the other parts, so a worker does not do its neighbour's
part. A part may go to a running worker or an open session as above. Add the rest before
every waiting task, in the order given, and start as many workers as `max_workers` allows.
Say one line per task, and how many wait for a slot.

If the work does not split into N such parts (fewer separate pieces, or the parts would edit
the same files), say so, propose the count that fits and why, and wait for the user. Do not
split into parts that depend on each other's branches.

## A session: `/qw <session name>: <task>`

A one-off helper request, not a queue task; no entry in `queue.md` or `config.json`.

Send the task to that session with SendMessage, self-contained: what is needed, that it comes
from the user through the queue coordinator, and that it should reply to you by SendMessage
when done. Never pass credentials. Say in one line that it was sent.

When the reply comes, pass it on to the user, short. If the session asks a question, ask the
user and send the answer back. If the session is busy with an earlier helper request, the new
one waits until it answers, as for any helper.
