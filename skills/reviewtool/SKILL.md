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
answers:

- **Usually the service is installed.** `systemctl --user start reviewtool` starts it again.
- **On a machine where it was never set up**, offer the user `reviewtool service` (keeps it running, also after a
  reboot) and `reviewtool tailscale` (opens it to their tailnet). For a one-off, start it in the background with
  `reviewtool serve --port 4477`.
- **Do not restart or stop a server someone else started.**

The links `reviewtool url` prints use the tailnet address once `reviewtool tailscale` has run. Give the user those
links, not localhost.

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
      "group": "Planning",
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

- **Phone screenshots: same page or a page of their own, your choice.**
  - Same screen on both: add `"mobile"` (and `"mobileBefore"` when you have one) to the desktop page. The reviewer
    switches between Desktop and Phone on that page and gives one verdict for both.
  - A phone screen that deserves its own verdict, or that has no desktop equivalent (a drawer, a bottom sheet, a
    phone-only layout): make a separate page with `"device": "phone"`. Its `before` and `after` are then the phone
    screenshots, shown at phone width. A folder such as `"Phone"` or `"CRM/Phone"` keeps such pages together.
- **Put pages in folders with `group`** when a round has more than a handful of pages. Use the product's own areas
  (`"CRM"`, `"Settings/Team & access"`), and use `/` to nest. A page keeps its folder in later rounds unless you name
  another; `"group": ""` takes it out. To sort the pages of a round that is already published, run
  `reviewtool group <name> <page-id>... --to "Settings/Team & access"`. Titles don't need to repeat the folder:
  "Members" in `Settings/Team & access`, not "Settings · Members".
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

The user reviews in the browser and presses **Send** when they are done. Wait for that; do not poll `feedback` in a
loop, and do not start fixing half-finished feedback.

**In T3 Code** (the environment has `T3CODE_THREAD_ID`), `init`, `round` and `wait` link the review to your thread.
The button then reads **Send to T3 thread**, and the user's feedback arrives in your thread as a new message, with
the threads, verdicts and their note. So after publishing a round: show the review in the chat (below), tell the
user it is ready, and **end your turn**.
Do not run `wait`. When the message arrives, continue with step 4; it already contains what `feedback` prints.
`reviewtool target <name>` shows where feedback goes. `--here` links the current thread, and `--none` unlinks it.

**Show the review inside the T3 chat** when a public link is set up (`reviewtool url <name> --public` prints one
instead of an error): pass the output of `reviewtool embed <name> [<page-id>]` as the `html` of T3's `html_render`
tool, with height 900 and a title like "Review: round 3". The user reviews right there. T3's chat cannot reach
private or tailnet addresses, so without a public link, give the tailnet link instead. The embed holds the link's
secret key: show it only in the user's own thread, and never paste the key or the public link into a pull request,
issue, log or commit.

**Anywhere else**, wait for the user to send:

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
- An agent blocked in `wait` always gets the feedback itself, even when the review is linked to a T3 thread, so it
  never arrives twice.

## 4. Read the feedback

```sh
reviewtool feedback <name>          # threads waiting for you: open, and the user spoke last
reviewtool feedback <name> --json   # the same as JSON, plus the verdicts of the latest round
```

Each thread shows:

- its id in brackets;
- the page and the round;
- the spots it marks: the text names them `[1]`, `[2]`, … at the place the user means them, and each is listed with
  its screenshot and a percentage across and down (a comment without spots is about the page as a whole);
- the path to each image, so you can open it and look at the exact spot;
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
