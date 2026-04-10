import { z } from 'zod';

export interface JumpCloudConfig {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

export const UserGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export type UserGroup = z.infer<typeof UserGroupSchema>;

export const UserGroupsResponseSchema = z.array(UserGroupSchema);

export const GroupMemberSchema = z.object({
  id: z.string(),
  type: z.string(),
});

export const GroupMembersResponseSchema = z.array(GroupMemberSchema);

export type GroupMember = z.infer<typeof GroupMemberSchema>;
