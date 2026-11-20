export interface GrantRevoker {
  listUserGrants(userId: string, options?: { cursor?: string; limit?: number }): Promise<{ items: { id: string }[]; cursor?: string }>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
}

/** Revoke every Life Diff MCP grant for a user. GitHub tokens are stored separately and are not in these grants. */
export async function revokeAllGrants(grants: GrantRevoker, userId: string): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await grants.listUserGrants(userId, { ...(cursor ? { cursor } : {}), limit: 50 });
    for (const grant of page.items) {
      await grants.revokeGrant(grant.id, userId);
      count += 1;
    }
    cursor = page.cursor;
  } while (cursor);
  return count;
}
