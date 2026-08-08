/**
 * @fileoverview Parses @mention patterns to determine which agents should respond.
 */

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
 * ...args", nothing else. Returns null for anything else (normal chat),
 * including a mention followed by ordinary text that merely contains a "/".
 *
 * @param {string} content - Raw message content from the user
 * @param {import('../store/db.js').Agent[]} chatMembers - Agents currently in the chat
 * @returns {{ agent: import('../store/db.js').Agent, command: string } | null}
 */
export function parseSkillInvocation(content, chatMembers) {
  const match = content.trim().match(/^@(\w+)\s+(\/\S.*)$/s);
  if (!match) return null;
  const agent = chatMembers.find((a) => a.name.toLowerCase() === match[1].toLowerCase());
  return agent ? { agent, command: match[2] } : null;
}
