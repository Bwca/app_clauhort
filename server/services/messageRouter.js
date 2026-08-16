/**
 * @fileoverview Parses @mention patterns to determine which agents should respond.
 */

import { listAgentCommands } from './commands.js';
import { getAgentSkills } from './agentProcessManager.js';

/**
 * Extracts the chat members explicitly @mentioned in a message. Unlike
 * parseResponders, this never falls back to "everyone" when there are no
 * mentions — it's used to detect actual delegation (e.g. in an agent's
 * reply), where the absence of a mention means "nobody", not "broadcast".
 *
 * @param {string} content - Raw message content
 * @param {import('../store/db.js').Agent[]} chatMembers - Agents currently in the chat
 * @returns {import('../store/db.js').Agent[]} Agents explicitly @mentioned, possibly empty
 */
export function extractMentionedAgents(content, chatMembers) {
  const mentionRegex = /@(\w+)/g;
  const mentions = [...content.matchAll(mentionRegex)].map((m) =>
    m[1].toLowerCase()
  );

  return chatMembers.filter((agent) =>
    mentions.includes(agent.name.toLowerCase())
  );
}

/**
 * Parses @Name mentions from a user's message to determine which agents
 * should respond. If no mentions are found, all NON-OBSERVER members respond
 * (broadcast) — an observer agent (agent.isObserver) never responds to a
 * broadcast, only to an explicit @mention (resolved above via
 * extractMentionedAgents, which is NOT filtered — an observer must still be
 * reachable by name, whether typed directly, relayed by a teammate's reply,
 * or via a scheduled message).
 *
 * @param {string} content - Raw message content from the user
 * @param {import('../store/db.js').Agent[]} chatMembers - Agents currently in the chat
 * @returns {import('../store/db.js').Agent[]} Agents that should respond
 */
export function parseResponders(content, chatMembers) {
  const mentioned = extractMentionedAgents(content, chatMembers);
  return mentioned.length > 0 ? mentioned : chatMembers.filter((agent) => !agent.isObserver);
}

/**
 * Detects a skill-invocation message: the ENTIRE message is "@Name /command
 * ...args", nothing else, AND "/command" is either one of that agent's
 * actual registered custom commands (`.claude/commands/*.md` in its
 * workingDir — see commands.js) OR one of the built-in/marketplace/plugin
 * skills its own live process reported having (getAgentSkills in
 * agentProcessManager.js — populated from the CLI's own `skills` list on
 * its `system/init` event). Returns null for anything else (normal chat),
 * including a mention followed by ordinary text that merely contains a "/",
 * AND a syntactically-valid "@Name /word" whose word isn't a real command.
 *
 * That last case matters more than it looks: `newMessage.content` for a
 * genuine skill invocation is sent to the CLI as a BARE "/word" string, with
 * no "@Name " prefix — and the `claude` CLI recognizes ITS OWN built-in
 * local commands (e.g. "/chrome", "/help", "/clear" — an entirely different,
 * larger set than this project's custom commands, and NOT the same list as
 * `skills` above — confirmed those meta-commands are absent from `skills`)
 * by that same bare-leading-slash syntax. Confirmed live: sending
 * "@SomeAgent /chrome" against an agent with no "/chrome" custom command got
 * the CLI's own local-command dispatcher to intercept it —
 * {"type":"system","subtype":"local_command"} in the session transcript —
 * before the model ever saw the turn, silently discarding the [System]
 * preamble sent alongside it in the same turn (see buildPromptBlocks in
 * ws/handler.js). Since that preamble only ever goes out once per agent per
 * chat, the agent's identity was lost for good the moment its first-ever
 * message happened to collide with a CLI-native command name. Validating
 * against the real command/skill list closes this: anything that isn't an
 * actual registered skill now falls through to parseResponders as ordinary
 * chat text (content kept intact, "@Name " prefix included), which doesn't
 * match the CLI's bare-slash trigger.
 *
 * @param {string} content - Raw message content from the user
 * @param {import('../store/db.js').Agent[]} chatMembers - Agents currently in the chat
 * @returns {{ agent: import('../store/db.js').Agent, command: string } | null}
 */
export function parseSkillInvocation(content, chatMembers) {
  const match = content.trim().match(/^@(\w+)\s+(\/\S.*)$/s);
  if (!match) return null;
  const agent = chatMembers.find((a) => a.name.toLowerCase() === match[1].toLowerCase());
  if (!agent) return null;
  const commandName = match[2].slice(1).split(/\s/)[0];
  const isRegisteredCommand = listAgentCommands(agent.workingDir).some((c) => c.name === commandName)
    || getAgentSkills(agent.id).includes(commandName);
  return isRegisteredCommand ? { agent, command: match[2] } : null;
}
