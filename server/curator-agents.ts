const DEFAULT_REGISTRATION_TTL_MS = 60 * 60_000;
const activeCuratorAgentIds = new Map<string, number>();

/** Track one plugin-owned curator agent for permission-denial enforcement. */
export function registerCuratorAgentId(
  agentId: string,
  expiresAt = Date.now() + DEFAULT_REGISTRATION_TTL_MS,
): () => void {
  activeCuratorAgentIds.set(agentId, expiresAt);
  return () => activeCuratorAgentIds.delete(agentId);
}

/** True only while the plugin-owned curator registration remains live. */
export function isRegisteredCuratorAgentId(agentId: string, now = Date.now()): boolean {
  const expiresAt = activeCuratorAgentIds.get(agentId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    activeCuratorAgentIds.delete(agentId);
    return false;
  }
  return true;
}

/** Clear every registration during plugin cleanup. */
export function clearRegisteredCuratorAgentIds(): void {
  activeCuratorAgentIds.clear();
}
