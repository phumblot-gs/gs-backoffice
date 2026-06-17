import { z } from 'zod';

export interface JumpCloudConfig {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

// A resolved user group — `name` is always populated (from the group-name cache).
export const UserGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export type UserGroup = z.infer<typeof UserGroupSchema>;

// Raw entry returned by GET /v2/users/{id}/memberof. This endpoint returns the
// group id and type but NOT the name — the name is resolved separately from the
// /usergroups cache, so it must be optional here (otherwise parsing fail-closes
// every real user, since `name` is always absent in the API response).
export const MemberOfEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
});

export const UserGroupsResponseSchema = z.array(MemberOfEntrySchema);

export const GroupMemberSchema = z.object({
  id: z.string(),
  type: z.string(),
});

export const GroupMembersResponseSchema = z.array(GroupMemberSchema);

export type GroupMember = z.infer<typeof GroupMemberSchema>;
