# reviewtool

Review UI changes in rounds, the way you would with a designer, while an AI agent does the work.

1. **The agent publishes a round** of screenshots of every page it changed. reviewtool compares each one with the
   previous round, so you can see which pages changed and where.
2. **You go through the pages.** You compare each with the previous round and round 1, **approve** the ones that are
   right, and click a screenshot to put a numbered **marker** on what you want to talk about.
3. **You give your feedback in the chat**, naming the markers: "[1] is too tall, [2] should line up with it". Nothing
   is sent from the app: the agent pulls your approvals and markers with `reviewtool markers`, fixes, and publishes the
   next round. In [T3 Code](https://t3.codes) the review sits at the end of the agent's reply, inside the chat.
4. **The pull request gets a log of the whole review.** It is one comment, kept up to date, with every round, its
   notes and which pages were approved.

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
- **Only the addresses you allow get through.** `--allow` puts an IP allowlist in the printed web server setup;
  everyone else is cut off without an answer, and request logging is off so the key stays out of logs. `--new-key`
  replaces the key, and every older link stops working.
- **Agents end their reply with the review** (`reviewtool embed <name>`, HTML for T3's `html_render`), and you
  give your feedback in the chat itself. In the chat, the review only has *Approve* and markers: click a screenshot
  to put a numbered marker there, [1], [2], …, and name it in your message ("[1] is too tall"); click it again to
  remove it. The agent looks the markers up with `reviewtool markers <name>`: page, screenshot, spot and image.
  Numbers are never reused within a round. `reviewtool url <name> --public` prints the link with its key; anyone who
  has that link can open the review.
- `reviewtool relay --remove` stops the tunnel and forgets the key.

## How a review goes

```sh
reviewtool init inbox-redesign --title "Inbox redesign" --repo acme/app --pr 42
reviewtool round inbox-redesign round.json --as Claude
reviewtool embed inbox-redesign            # in T3 Code: the review inside the chat (or: reviewtool url)
#   … you approve pages, place markers and write in the chat: "[1] is too tall" …
reviewtool markers inbox-redesign          # where [1] is: page, round, spot, image
reviewtool round inbox-redesign round2.json --as Claude
reviewtool log inbox-redesign --post
```

What each command does:

- `init` starts a review. A good name is the branch name.
- `round` publishes the screenshots listed in a manifest as the next round, and prints what changed since the last
  round, such as `5 changed, 1 new, 30 unchanged since round 3`.
- `embed` prints the page an agent shows inside a T3 chat; `url` prints the link for a browser.
- `markers` lists the markers of the latest round, each with its page, which round's screenshot it is on, where on it,
  and the image path, plus which pages are approved.
- `log --post` creates the review log comment on the PR, or updates it if it was posted before.
- `wait`, `feedback`, `reply`, `comment` and `resolve` are from the earlier, send-based way of working. They still
  read and write older reviews, but the app no longer sends or takes comments.

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

The page has one bar on top with nothing beyond what a review needs: the rounds (#1, #2, …), a ☰ button that lists
the pages of the round (*To do* above *Done*) and says which page you are on (12/70), how many pages are still to do,
and **Approve**; markers go on the screenshot. It is built on
[Pico CSS](https://picocss.com), which ships inside the package, and follows your light or dark setting (black inside
a chat).

- **A gallery of what needs you.** A review opens on the first page that needs you. *Approve* finishes a page, and so
  does putting a marker on it (you will talk about it in the chat); the next page that needs you opens and the finished
  one moves to *Done*. Pages that did not change since you approved them last round are done already. <kbd>N</kbd>
  jumps ahead.
- **Previous and next at your fingertips.** Hovering a screenshot shows ‹ and › at its edges for the previous and
  next page (<kbd>←</kbd> and <kbd>→</kbd> do the same, once you have clicked anything in the review).
- **A heading that says what this is.** The top bar reads "*T3 thread* · *what this round changes*": the agent sums
  up each round in about five words (the round's title).
- **This round against earlier ones, in one place.** One screenshot at a time, with a bar under it: *#1* (the first
  round), *Previous* (the last round) and *Current*. A click switches in place, so what changed jumps out;
  <kbd>Space</kbd> or <kbd>B</kbd> jumps between current and the last other round you looked at. Areas that changed
  since the last round are outlined on the current one. A page with nothing earlier to compare (round 1, or a page
  that is new, such as one you asked for) gets one line instead: "New in #4 · nothing to compare". The `before` screenshots in a manifest are not shown.
- **Point at what you mean.** Click a screenshot to put a numbered marker there, [1], [2], …; click it again to remove
  it. Numbers are never reused within a round. Then write in the chat; with dictation, "the header 1 is too tall"
  works as well as "[1]".
- **Know what's new.** The page list marks pages that *changed* or are *new* since the last round.
- **Keyboard.** <kbd>←</kbd>/<kbd>→</kbd> (or <kbd>K</kbd>/<kbd>J</kbd>) previous or next page, <kbd>N</kbd> next page that needs you,
  <kbd>1</kbd> approve, <kbd>Space</kbd> or <kbd>B</kbd> swap with an earlier round, <kbd>?</kbd> for the list.

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
