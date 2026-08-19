# Plan 06 — Slash commands (`/command`)

Depends on: an agent whose working directory contains at least one real
`.claude/commands/*.md` skill file, so the autocomplete has something to
show. Set this up in the scratch directory (do **not** point a test agent
at this repo's own working directory — a test agent has real tool access
inside whatever directory it's pointed at, and this repo is not a
disposable sandbox):
```bash
mkdir -p /tmp/clauhort-test-workdir/.claude/commands
cat > /tmp/clauhort-test-workdir/.claude/commands/ping.md <<'EOF'
---
description: Replies with pong
---
Reply with exactly the word "pong".
EOF
```
and point `TP-SkillAgent`'s working dir at `/tmp/clauhort-test-workdir`.

## 1. Autocomplete on `/`

1. In a chat containing `TP-SkillAgent` (and at least one other agent, to
   test disambiguation), type `/` in the message input.
2. **Expected**: an autocomplete list of `TP-SkillAgent`'s available
   commands appears with descriptions (per README: "typing `/` shows an
   autocomplete of that agent's available commands, with descriptions").
   Confirm the `ping` command (or whatever you set up) is listed with its
   `description:` frontmatter text.

## 2. Explicit invocation with multiple agents in chat

1. Send `@TP-SkillAgent /ping`.
2. **Expected**: this is parsed as a full skill invocation (per
   `CLAUDE.md`'s `parseSkillInvocation` — "a message that is *entirely*
   `@Name /command ...`"), not routed as a normal chat message. Only
   `TP-SkillAgent` responds, invoking the real command, and its reply is
   `pong` (or close to it, allowing for normal LLM phrasing around the
   literal instruction).

## 3. Shorthand — single agent in chat, no `@mention` needed

1. Create or use a chat with **only** `TP-SkillAgent** as a member.
2. Send just `/ping` (no `@mention`).
3. **Expected**: per README ("or just `/command` in a chat with only one
   agent"), this resolves the same as `@TP-SkillAgent /ping` would.

## 4. Not-entirely-a-command text isn't misfired

1. Send `@TP-SkillAgent can you run /ping for me?` (command-looking text
   embedded in an ordinary sentence, not the *entire* message).
2. **Expected**: per `CLAUDE.md`, `parseSkillInvocation` only fires when the
   message is *entirely* `@Name /command ...` — this should be treated as
   a normal chat message (agent sees the literal text and may or may not
   choose to run its own `/ping` skill via its own tool use, but the app
   itself should not silently intercept and skill-invoke on your behalf).

## 5. Unknown command

1. Send `@TP-SkillAgent /does-not-exist`.
2. **Expected**: a clear error/handling rather than a silent hang or crash
   — check what actually happens (does the agent receive it as literal
   text and say it doesn't have that command, or does the app reject it
   client-side before sending?).

## Cleanup

Remove the throwaway `.claude/commands/ping.md` if you created it:
```bash
rm -rf /tmp/clauhort-test-workdir/.claude
```
