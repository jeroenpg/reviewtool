---
name: reviewtool
description: Run a screenshot review with the user in rounds. Publish before/after screenshots of UI changes to the reviewtool web app, wait until the user sends their feedback, read the comments they pin on the screenshots, fix the issues and reply to each comment, publish the next round (reviewtool shows which pages changed), and put the review log on the pull request. Use when the user wants to review UI changes visually, asks for a review round or the review tool, or leaves feedback in it ("I left comments", "check the review").
---

# Screenshot review rounds with reviewtool

`reviewtool` is a small local web app plus a CLI. You publish a **round** of screenshots, and the user opens the app,
compares before and after, pins comments on the screenshots and gives each page a verdict. You read that feedback with
the CLI, fix the issues, reply to every comment and publish the next round. At the end you post the whole history to
the pull request as one comment.

Check that it is installed with `reviewtool --help`. If it is not, install it with
`npm install -g github:jeroenpg/reviewtool`.

## 1. Start a review (once per piece of work)

```sh
reviewtool list                                   # does a review for this branch or PR exist already? Reuse it.
reviewtool init <name> --title "Declutter the inbox" --repo owner/repo --pr 123 --branch my-branch
```

`<name>` is lowercase letters, digits and dashes. A good choice is the branch name with `/` changed to `-`. Add
`--repo` and `--pr` later with `reviewtool set <name> --pr 123` once the PR exists.

The app must be running for the user to see anything. Check with `curl -s localhost:4477/api/reviews`. If nothing
answers, start it in the background with `reviewtool serve --port 4477`. Leave it running and do not restart a server
someone else started. Set `REVIEWTOOL_URL` when the user reaches the app at another address, such as a tailnet
hostname, so the links you print work for them.

## 2. Publish a round

Take the screenshots first: desktop, and phone too when the change affects phones. Capture every page the change
touches, in the states the change is about (hovered, open, empty, error).

- **Before**: the state before the work, from main or production. Keep the same before in every round. When a page
  in the manifest has no `before`, reviewtool reuses the before from the previous round.
- **After**: the current state of your branch.

Then write a manifest anywhere you like, for example `/tmp/round.json`. Image paths are relative to the manifest file.
The images are copied into the review store (`~/.local/share/reviewtool`), so later cleanups cannot delete them.

```json
{
  "title": "Inbox actions on hover",
  "notes": "What changed since the last round, in one or two sentences.",
  "pages": [
    {
      "id": "inbox",
      "title": "Inbox",
      "route": "/inbox",
      "before": "shots/before-inbox.png",
      "beforeLabel": "main",
      "after": "shots/after-inbox.png",
      "afterLabel": "this branch",
      "mobile": "shots/after-inbox-phone.png",
      "note": "Optional: what to look at on this page."
    }
  ]
}
```

```sh
reviewtool round <name> /tmp/round.json --as Claude
reviewtool url <name>
```

- **Keep page ids the same across rounds.** Change detection, the "Last round" view and the "new" badges match
  pages by id.
- **Look at every screenshot before you publish it.** Do not publish captures with error toasts, spinners, or the
  wrong page or user.
- **Read the change summary `round` prints**, for example `(5 changed, 1 new, 30 unchanged since round 3)`.
  reviewtool compares every screenshot with the same page in the previous round, pixel by pixel, and boxes what
  changed. If a page you fixed shows as unchanged, your fix did not reach the screenshot; recapture before you tell the
  user. If a page you did not touch shows as changed, find out why. `reviewtool rounds <name>` lists the change per
  page.
- Give the user the link from `reviewtool url`, and tell them how many pages the round has and which ones changed.
  The user can approve the unchanged pages they approved last round in one click, so they only look at what changed.

## 3. Wait for the user to send feedback

The user reviews in the browser and presses **Send to agent** when they are done. Wait for that; do not poll
`feedback` in a loop, and do not start fixing half-finished feedback.

```sh
reviewtool wait <name> --as Claude
```

`wait` blocks until the user sends, marks the feedback as picked up (the app then shows "Claude is working on your
feedback"), prints it like `feedback` does, plus the user's note, and exits 0. While it waits, the app shows the user
"Claude is waiting for your feedback".

- **Claude Code:** run it as a background command (`run_in_background`, timeout up to 2 hours); you are notified when
  it exits. Meanwhile, tell the user the round is ready and that you are waiting for them to press Send to agent.
- **Agents that can only run commands in the foreground:** use `--timeout` below your command limit, for example
  `reviewtool wait <name> --timeout 540`. Exit code 2 means nothing was sent yet; run it again.
- Sent feedback stays pending until an agent picks it up, so nothing is lost if no one was waiting at that moment.
- If the user tells you in the chat that they are done instead, skip the wait and read `reviewtool feedback <name>`.

## 4. Read the feedback

```sh
reviewtool feedback <name>          # threads waiting for you: open, and the user spoke last
reviewtool feedback <name> --json   # the same as JSON, plus the verdicts of the latest round
```

Each thread shows:

- its id in brackets;
- the page and the round;
- where it is pinned, as a percentage across and down the screenshot;
- the path to that image, so you can open it and look at the exact spot;
- the conversation so far.

Verdicts mean:

- **Approve**: keep the page as it is.
- **Needs update**: keep the change and apply the comments.
- **Revert**: put the page back the way it was before.

## 5. Fix, then reply to every thread

Fix the issues. Then reply to each thread with what you did, in plain words the user can check on the next round's
screenshot:

```sh
reviewtool reply <name> <comment-id> "Moved snooze to the end of the row; it replaces the time on hover." --as Claude
```

- **Every thread you were shown gets a reply, even when you disagree or could not do it.** In that case say why, and
  what the user can decide.
- **Do not resolve threads yourself.** The user resolves them after checking. The exception is `--resolve`, for a
  thread that needs no change: a question you answered, or a duplicate.
- When the user answers in a thread, it shows up in `feedback` again.
- To leave a note on a page without a thread, for example "this page also changed because of X", use
  `reviewtool comment <name> <page-id> "..." --as Claude`.

Then capture the screenshots again, publish the next round (step 2) and wait again (step 3). Repeat until the user
sends feedback with every page approved and nothing waiting.

## 6. Put the log on the pull request

When the PR exists, and again whenever a round finishes:

```sh
reviewtool set <name> --repo owner/repo --pr 123   # if not set yet
reviewtool log <name> --post
```

This creates one comment on the PR, or updates the one it posted before. The comment holds every round, the verdict
for each page and each comment thread with its replies. To preview it, run `reviewtool log <name>`. To save it to a
file, run `reviewtool log <name> --out file.md`.

## Rules

- **Never publish a round with screenshots you have not looked at.**
- **Never edit the store's JSON files by hand.** Use the CLI, which locks the files so the user's comments and yours
  cannot overwrite each other.
- **Speak as an agent through the CLI** (`--as Claude`, or your own name). The browser is for people.
