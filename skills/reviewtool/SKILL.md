---
name: reviewtool
description: Run a screenshot review with the user in rounds. Publish screenshots of UI changes to the reviewtool web app and show it to the user; they approve pages and put numbered markers on screenshots, then give their feedback in the chat, naming the markers ([1], [2]). Look the markers up, fix, publish the next round (reviewtool shows which pages changed), and put the review log on the pull request. Use when the user wants to review UI changes visually, asks for a review round or the review tool, or names markers like [1] in the chat.
---

# Screenshot review rounds with reviewtool

`reviewtool` is a small web app plus a CLI. You publish a **round** of screenshots and show the review to the user.
In it they compare each page with earlier rounds, **approve** the pages that are right, and click screenshots to put
**numbered markers** on them. Nothing is sent from the app: the feedback is the user's next chat message, which names
the markers ("[1] is too tall"). You pull the approvals and markers with the CLI, fix, and publish the next round. At
the end you post the whole history to the pull request as one comment.

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

- **After**: the current state of your branch. The reviewer compares it with the same page in the previous round
  and in round 1, so keep page ids the same from round to round.
- **Before** (optional): the state before the work, from main or production. The app does not show it; it is kept
  with the round. When a page in the manifest has no `before`, reviewtool reuses the one from the previous round.

**Give every round a title of about five words that sums up what it changes** ("Calmer sidebars, fewer buttons"), in
the manifest's `title` or with `--title`. The app shows it in its top bar after the name of your T3 thread (or the
review's name): "Reduce frontend clutter · Calmer sidebars, fewer buttons".

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

- **Phone screenshots are always a page of their own**, judged on their own.
  - The phone version of a desktop page: add `"mobile"` (and `"mobileBefore"` when you have one) to the desktop
    page. It becomes the page `<id>-phone`, right after the desktop one.
  - A phone screen with no desktop equivalent (a drawer, a bottom sheet, a phone-only layout): make a page with
    `"device": "phone"`. Its `before` and `after` are then the phone screenshots, shown at phone width.
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
- Pages that did not change since the user approved them last round count as done already, so they only look at
  what changed.

## 3. Show the review and end your turn

**In T3 Code with a public link** (the environment has `T3CODE_THREAD_ID`, and `reviewtool url <name> --public`
prints a link instead of an error): end your reply with the review. Pass the output of `reviewtool embed <name>` as
the `html` of T3's `html_render` tool, with a title like "Review: round 3" and the height it prints on stderr
("html_render height: …"). The embed holds the link's secret key: show it only in the user's own thread, and never
put the key or the public link in a pull request, issue, log or commit.

**Anywhere else**, give the link from `reviewtool url <name>` (T3's chat cannot show private or tailnet addresses).

Keep the reply short: how many pages, which changed, and once that clicking a screenshot places a marker to name in
the chat. Then **end your turn**. Do not wait or poll: the user's next message is the feedback.

## 4. Pull the feedback when the user writes

The user's message is the feedback. When it names markers ([1], [2], …) or the review, look them up:

```sh
reviewtool markers <name>          # each [n]: page, which round's screenshot, spot (% across and down), image path
reviewtool markers <name> --json   # the same, plus the approved and not approved pages
```

- **Open the image** at the listed path to see the exact spot.
- **Dictation often drops the brackets** ("the header 1 is too tall"); read a number that fits as that marker.
- **Marker numbers are never reused within a round**, so [n] always means the spot listed under it.
- **Approved pages stay as they are.** The chat says what to change on the rest; a page without approval and without
  a word about it is not done yet, so ask.
- A marker can sit on the current screenshot, the previous round's or round 1's; the list says which. A spot on an
  earlier round usually means "it was better like this".

## 5. Answer, fix, publish the next round

Answer in the chat, per marker, what you will do; when you disagree or cannot do something, say why. Then fix it,
capture again, and publish the next round (step 2) with `notes` that sum up the feedback you acted on, so the log on
the pull request keeps it. Show the review again (step 3). Repeat until every page is approved.

## 6. Put the log on the pull request

When the PR exists, and again whenever a round finishes:

```sh
reviewtool set <name> --repo owner/repo --pr 123   # if not set yet
reviewtool log <name> --post
```

This creates one comment on the PR, or updates the one it posted before. The comment holds every round with its notes
and which pages were approved. To preview it, run `reviewtool log <name>`. To save it to a
file, run `reviewtool log <name> --out file.md`.

## Rules

- **Never publish a round with screenshots you have not looked at.**
- **Never edit the store's JSON files by hand.** Use the CLI, which locks the files so the user's comments and yours
  cannot overwrite each other.
- **The feedback lives in the chat.** Do not use `wait`, `feedback`, `reply` or `comment`; they belong to an older way
  of working where the app sent feedback, and the app no longer does.
