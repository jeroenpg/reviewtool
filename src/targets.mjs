// Where a review's feedback goes when the reviewer presses send. Today: a T3 Code thread, reached through T3's own
// command line (`t3 thread send`), so the feedback arrives in the agent's chat as a new message.
import { execFile, execFileSync } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

const THREAD_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function validCli(cli) {
  return typeof cli === 'string' && isAbsolute(cli) && /^t3(\.exe)?$/.test(basename(cli));
}

/**
 * Detects the T3 Code thread the calling agent runs in, from the environment T3 gives its agents. Returns null outside
 * T3, or when REVIEWTOOL_TARGET=none opts out.
 */
export function detectTarget(env = process.env, { agent = null, lookup = true } = {}) {
  if (env.REVIEWTOOL_TARGET === 'none') return null;
  const thread = env.T3CODE_THREAD_ID;
  const cli = env.T3CODE_CLI_PATH;
  if (!thread || !THREAD_ID.test(thread) || !validCli(cli)) return null;
  const target = { kind: 't3', thread, cli, home: env.T3CODE_HOME || null, title: null, link: null, agent };
  if (lookup) {
    try {
      const args = ['thread', 'show', thread, '--json', '--messages', '0', ...(target.home ? ['--base-dir', target.home] : [])];
      const info = JSON.parse(execFileSync(cli, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })).thread;
      target.title = info?.title ?? null;
      target.link = info?.link ?? null;
    } catch {}
  }
  return target;
}

export function targetLabel(target) {
  if (target?.kind !== 't3') return null;
  return target.title ? `T3 thread "${target.title}"` : 'the T3 thread';
}

/** Sends the message into the target's thread. Resolves on success, rejects with a readable error. */
export function deliver(target, message) {
  if (target?.kind !== 't3' || !THREAD_ID.test(target.thread) || !validCli(target.cli)) return Promise.reject(new Error('no valid delivery target'));
  const args = ['thread', 'send', ...(target.home ? ['--base-dir', target.home] : []), target.thread, '-'];
  return new Promise((resolvePromise, reject) => {
    const child = execFile(target.cli, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n').at(-1) || 'T3 did not accept the message'));
      else resolvePromise(stdout);
    });
    child.stdin.end(message);
  });
}
