# reviewtool

Review UI changes in rounds, the way you would with a designer, while an AI agent does the work.

1. **The agent publishes a round.** It sends before and after screenshots of every page it changed, plus phone
   screenshots if it has them. reviewtool compares each screenshot with the previous round, so you can see which
   pages changed and where.
2. **You review them in the browser.** You compare before with after, or this round with the last one. You click a
   spot to pin a comment there, and you approve each page or comment on what should change.
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

### Reviewing inside an agent chat (T3 Code)

T3 Code can show a page inside the chat, but that page may only reach the public internet, not your tailnet or
localhost. To review there, give the app a public address through a server you can ssh into:

```sh
reviewtool relay --via user@server --url https://review.example.com
```

- **Nothing on your machine opens up.** A systemd user service keeps an ssh tunnel to the server open, and on the
  server a web server you run (the command prints a Caddy example) sends the public address into the tunnel. Without
  a domain, a name like `review.<ip-with-dashes>.sslip.io` resolves to the server and gets a certificate.
- **The public side needs a secret key**, which `relay` creates and keeps in `~/.config/reviewtool/config.json`.
  The app answers the tunnel on a separate local port where every request must carry it, so it holds even for
  other users on the server. Your tailnet link keeps working without it.
- **Agents show the review in the chat** with `reviewtool embed <name>` (HTML for T3's `html_render`), and
  `reviewtool url <name> --public` prints the link with its key. Anyone who has that link can open the review.
- `reviewtool relay --remove` stops the tunnel and forgets the key.

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
- **Phone screenshots are always a page of their own.** A page with `"device": "phone"` has phone screenshots as its
  `before` and `after`, shown at phone width. `mobile` (and `mobileBefore`) on a desktop page are a shorthand: they
  become such a phone page, `<id>-phone`, right after it, with its own approval and comments.
- **`group` puts a page in a folder** of the page list, such as `"CRM"` or nested `"Settings/Team & access"`. A page
  keeps its folder in later rounds unless the manifest names another. `reviewtool group <name> <page-id>... --to
  <folder>` re-sorts a round that is already published.
- **You can leave out `before`.** A page without one reuses its before from the previous round, because the main
  screenshot rarely changes.

## In the browser

The page has no buttons beyond what a review needs: **Approve**, the comment box, **Send**, and the rounds (#1, #2,
…) in the top bar. The pages of the round are listed on the left, *To do* above *Done*; on a phone or tablet (or in an
agent chat) the list becomes a picker. It is built on [Pico CSS](https://picocss.com), which ships inside the package,
and follows your light or dark setting.

- **A gallery of what needs you.** A review opens on the first page that needs you: not approved yet, an answer from
  the agent to check, or a new reply. *Approve* finishes the page, and so does posting a comment (which marks the page
  as needing an update); the next page that needs you opens and the finished one moves to *Done*. Pages that did not
  change since you approved them last round are done already. <kbd>N</kbd> jumps ahead.
- **Before and after, nothing to set.** They sit side by side; where that would be too small to read (a tablet, an
  agent chat), they are on top of each other with a handle to swipe between them. A page with phone screenshots shows
  them underneath. Areas that changed since the last round are outlined.
- **Comment while you look, and point at what you mean.** The comment box is always under the page. Press
  <kbd>Enter</kbd> (or <kbd>G</kbd>) to write; while you write, each click on a screenshot puts a numbered marker on
  that spot and its number, like `[1]`, in your text where the cursor is, so one comment can point at several spots
  (also on the before and the after). Delete `[1]` from the text, or click the marker, to take it away.
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> posts, and <kbd>Esc</kbd> stops writing, so the keys work again; your text stays,
  also when you go to another page. Click a marker to open its thread; comments without a marker on screen are listed
  under the screenshots.
- **Dictate and point.** With dictation (Wispr Flow, a phone keyboard) the text arrives after you stop talking, so
  click the spots while you speak and say their number: "the header one is too tall, and this card two…". When the
  text lands, each marker moves to where you said it: "the header [1] … this card [2]". Digits, English and Dutch
  number words work, with or without "spot", "marker", "nummer" or "punt" before them; Dutch "een" only counts after
  one of those, as it is also the word "a". Once you type by hand, the markers stay where you clicked them.
- **Send when you are done.** *Send to agent* (or *Send to T3 thread*) counts what you have added since you last
  sent, and takes an optional note. The top bar shows when an agent is waiting for you and when your feedback was
  delivered.
- **Know what's new.** Each page in the list shows its most urgent signal: new replies (purple), threads the agent
  answered that you have not resolved yet (orange), or that the page changed.
- **Keyboard.** <kbd>J</kbd>/<kbd>K</kbd> next or previous page, <kbd>N</kbd> next page that needs you,
  <kbd>1</kbd> approve, <kbd>Enter</kbd> write, <kbd>Shift</kbd>+<kbd>S</kbd> send, <kbd>?</kbd> for the list.

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
