# reviewtool

Review UI changes in rounds, the way you would with a designer, while an AI agent does the work.

1. **The agent publishes a round.** It sends before and after screenshots of every page it changed, plus phone
   screenshots if it has them. reviewtool compares each screenshot with the previous round, so you can see which
   pages changed and where.
2. **You review them in the browser.** You compare before with after, or this round with the last one. You click a
   spot to pin a comment there, and you give each page a verdict: approve, needs update, or revert.
3. **You press Send.** Your comments, verdicts and an optional note go to the agent. In
   [T3 Code](https://t3.codes) they arrive in the agent's thread as a new message (*Send to T3 thread*). Anywhere
   else, an agent waiting with `reviewtool wait` picks them up. The agent fixes the issues, replies to each comment,
   and publishes the next round.
4. **The pull request gets a log of the whole review.** It is one comment, kept up to date, with every round, every
   verdict and every thread.

It is built so that Claude Code, Codex and other coding agents can drive it. The included
[skill](skills/reviewtool/SKILL.md) teaches them the loop.

The tool needs no dependencies, only Node.js 20 or newer. The web app's styling, [Pico CSS](https://picocss.com) (MIT, its neutral zinc theme), is included.

## Install

```sh
npm install -g github:jeroenpg/reviewtool
reviewtool install-skill   # Claude Code (~/.claude/skills) and Codex, Pi, OpenCode (~/.agents/skills)
reviewtool service         # keep the app running on http://127.0.0.1:4477, also after a reboot (Linux)
reviewtool tailscale       # open it to your tailnet: https://<machine>.<tailnet>.ts.net:14477
```

- **`install-skill`** links the skill into the global skill folders of Claude Code, Codex, Pi and OpenCode, so
  updating the package updates the skill. `--copy` copies it instead, and `--dir` installs into another folder.
- **`service`** writes a systemd user service. It starts at boot when user lingering is on
  (`loginctl enable-linger`). Elsewhere, run `reviewtool serve` with your own service manager.
- **`tailscale`** runs `tailscale serve` in the background, so only devices on your tailnet can open the app. It also
  remembers the address, so the links agents print work on your phone and other machines. If Tailscale asks for
  permission, run `sudo tailscale set --operator=$USER` once. Without Tailscale, the app listens on localhost only;
  set `REVIEWTOOL_URL` to whatever address you put in front of it.

## How a review goes

```sh
reviewtool init inbox-redesign --title "Inbox redesign" --repo acme/app --pr 42
reviewtool round inbox-redesign round.json --as Claude
reviewtool wait inbox-redesign --as Claude
reviewtool reply inbox-redesign 3f2a9c1e "Moved snooze to the end of the row." --as Claude
reviewtool round inbox-redesign round2.json --as Claude
reviewtool log inbox-redesign --post
```

What each command does:

- `init` starts a review. A good name is the branch name.
- `round` publishes the screenshots listed in a manifest as the next round.
- `round` also prints what changed since the last round, such as `5 changed, 1 new, 30 unchanged since round 3`.
- `wait` blocks until you press **Send to agent** in the browser. It then prints the threads waiting for the agent,
  with where each pin sits and the path of the image, plus your note. The app shows you when an agent is waiting and
  when it has picked up your feedback. Use `--timeout` for agents that cannot run long commands; exit code 2 means
  nothing was sent yet.
- `feedback` prints the same without waiting.
- **In T3 Code** you don't need `wait`. `init`, `round` and `wait` link the review to the agent's thread (from the
  `T3CODE_THREAD_ID` that T3 gives its agents). Sending then posts the feedback into that thread with
  `t3 thread send`, and a busy thread reads it as its next turn. `reviewtool target <name> --here | --none` changes
  the link. If T3 can't be reached, the feedback stays saved for the next `wait`. `REVIEWTOOL_TARGET=none` turns the
  linking off.
- `reply` answers one thread. Only you resolve threads, after you have checked the fix.
- The second `round` publishes the fixed screenshots as round 2.
- `log --post` creates the review log comment on the PR, or updates it if it was posted before.

A round manifest looks like this. Image paths are relative to the manifest file.

```json
{
  "title": "Snooze moved",
  "notes": "What changed since the last round.",
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
      "mobile": "shots/after-inbox-phone.png"
    }
  ]
}
```

Rules for manifests:

- **Only `id` and `after` are required.** Keep each page's `id` the same in every round. The "Last round" view and
  the "new" badge match pages by id.
- **Phone screenshots go on the same page or a page of their own.** `mobile` (and `mobileBefore`) add a phone
  variant to a desktop page; the reviewer switches with *Desktop / Phone* and gives one verdict. A page with
  `"device": "phone"` is a phone screen in its own right: its `before` and `after` are phone screenshots, shown at
  phone width. The agent picks per page.
- **`group` puts a page in a folder** of the page list, such as `"CRM"` or nested `"Settings/Team & access"`. A page
  keeps its folder in later rounds unless the manifest names another. `reviewtool group <name> <page-id>... --to
  <folder>` re-sorts a round that is already published.
- **You can leave out `before`.** A page without one reuses its before from the previous round, because the main
  screenshot rarely changes.

## In the browser

The app has two columns that stay put: the pages of the round on the left, and the page you are reviewing. On a
phone they stack, and the page list becomes a picker. It is built on
[Pico CSS](https://picocss.com), which ships inside the package, and follows your light or dark setting; the ◐ button in the top bar switches between following the system, light and dark.

- **Opens where you are needed.** A review opens on the first page that needs you: no verdict yet, an answer from
  the agent to check, or a new reply. <kbd>N</kbd> jumps to the next one.
- **Compare two ways.** Pick what to compare the after with (*vs Before* or *vs Last round*) and how (*Side by
  side*, *Swipe* with a draggable handle, or *After only*). *Phone* switches to the phone screenshots. *100%* zooms
  in, and the two screenshots then scroll together.
- **Comment while you look, and point at what you mean.** The comment box is always under the page. Press
  <kbd>Enter</kbd> (or <kbd>G</kbd>) to write; while you write, each click on a screenshot puts a numbered marker on
  that spot and its number, like `[1]`, in your text where the cursor is, so one comment can point at several spots
  (also on the before and the after). Delete `[1]` from the text, or click the marker, to take it away.
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> posts, and <kbd>Esc</kbd> stops writing, so the keys work again; your text stays,
  also when you go to another page. A comment without markers is about the page as a whole. Click a marker to open
  its thread; comments without a marker in the current view are listed under the screenshots.
- **Dictate and point.** With dictation (Wispr Flow, a phone keyboard) the text arrives after you stop talking, so
  click the spots while you speak and say their number: "the header one is too tall, and this card two…". When the
  text lands, each marker moves to where you said it: "the header [1] … this card [2]". Digits, English and Dutch
  number words work, with or without "spot", "marker", "nummer" or "punt" before them; Dutch "een" only counts after
  one of those, as it is also the word "a". Once you type by hand, the markers stay where you clicked them.
- **See what changed since the last round.** Pages are marked *changed*, *tiny change* or *new*, and changed areas
  are outlined on the screenshot (<kbd>H</kbd> turns the outlines off). The top of the page list says how many pages
  changed, and offers to approve, in one click, every unchanged page you already approved last round. *Unchanged*
  means pixel for pixel identical, so nothing that moved is skipped.
- **Send when you are done.** *Send to agent* (or *Send to T3 thread*) counts what you have added since you last
  sent, and takes an optional note. The top bar shows when an agent is waiting for you and when your feedback was
  delivered.
- **Know what's new.** Each page in the list shows its most urgent signal: new replies (purple), threads the agent
  answered that you have not resolved yet (orange), or that the page changed. The filters show all pages, the ones
  that need you, or the changed ones.
- **Keyboard.** <kbd>J</kbd>/<kbd>K</kbd> next or previous page, <kbd>N</kbd> next page that needs you,
  <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> for the verdicts, <kbd>S</kbd> <kbd>W</kbd> <kbd>A</kbd> for the layouts,
  <kbd>C</kbd> to switch the comparison, <kbd>P</kbd> phone, <kbd>Z</kbd> zoom, <kbd>G</kbd> page comment,
  <kbd>?</kbd> for the full list.

## Where the data lives

Reviews are kept in `~/.local/share/reviewtool`, or in `$REVIEWTOOL_HOME` if you set it.

- Every screenshot is copied into the store under the hash of its contents. Deleting a worktree or a temporary
  folder therefore cannot take a review's images with it.
- Writes from the browser and from the command line use a shared lock, so a comment and an agent's reply never
  overwrite each other.

## Commands

```
reviewtool serve [--port 4477] [--host 127.0.0.1]
reviewtool init <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
reviewtool set <name> [--title T] [--repo owner/name] [--pr N] [--branch B]
reviewtool list
reviewtool round <name> <manifest.json> [--title T] [--notes N] [--as Claude]
reviewtool rounds <name>
reviewtool group <name> <page-id>... --to <folder> [--round N]
reviewtool wait <name> [--as Claude] [--timeout SECONDS] [--json]
reviewtool feedback <name> [--all] [--round N] [--json]
reviewtool reply <name> <comment-id> <text> [--as Claude] [--resolve]
reviewtool comment <name> <page-id> <text> [--round N] [--as Claude]
reviewtool resolve <name> <comment-id> [--reopen]
reviewtool log <name> [--post] [--repo owner/name] [--pr N] [--out file]
reviewtool url <name> [<page-id>]
reviewtool target <name> [--here | --none]
reviewtool install-skill [--dir ~/.claude/skills]
```

To post the log, `log --post` needs the [GitHub CLI](https://cli.github.com) and a login with `gh auth login`.

## License

MIT
