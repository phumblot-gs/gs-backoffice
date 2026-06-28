/**
 * Contract test against Paperclip's NATIVE approvals API.
 *
 * It imports Paperclip's own zod validators from `@paperclipai/shared` (pinned to the
 * deployed Paperclip version) and asserts the request bodies our PaperclipClient sends
 * still satisfy them. If a future Paperclip upgrade changes the approval schema (renames
 * a field, drops a type, tightens a constraint), THIS TEST FAILS at build time — surfacing
 * the broken integration before it ships. On upgrade: bump the @paperclipai/shared devDep
 * to match the new Paperclip version and re-run.
 */
import { describe, it, expect } from 'vitest';
import {
  createApprovalSchema,
  resolveApprovalSchema,
  addApprovalCommentSchema,
} from '@paperclipai/shared';
import { APPROVAL_TYPES } from '@paperclipai/shared';

describe('Paperclip native approvals — request contract', () => {
  it('the approval type we use still exists', () => {
    // We file every sensitive-process approval as a generic board approval.
    expect(APPROVAL_TYPES).toContain('request_board_approval');
  });

  it('our createApproval body validates against createApprovalSchema', () => {
    const body = {
      type: 'request_board_approval',
      // requestedByAgentId omitted (null/undefined allowed) — the human requester lives
      // in payload.requestedBy because native approvals don't record a user requester.
      payload: {
        processCode: 'request_evolution',
        routineId: '11111111-1111-4111-8111-111111111111',
        requestedBy: 'phf@grand-shooting.com',
        scope: null,
        summary: 'Add a budget-alert Google Chat notification',
        projectName: 'gs-backoffice',
        parameters: { request: 'Long multi-line spec…' },
        notes: 'optional notes',
      },
    };
    expect(() => createApprovalSchema.parse(body)).not.toThrow();
  });

  it('createApproval accepts an optional issueIds array of UUIDs', () => {
    expect(() =>
      createApprovalSchema.parse({
        type: 'request_board_approval',
        payload: { processCode: 'x' },
        issueIds: ['22222222-2222-4222-8222-222222222222'],
      }),
    ).not.toThrow();
  });

  it('our resolve body validates (with and without a decision note)', () => {
    expect(() => resolveApprovalSchema.parse({})).not.toThrow();
    expect(() => resolveApprovalSchema.parse({ decisionNote: 'Looks good.' })).not.toThrow();
  });

  it('our comment body validates', () => {
    expect(() => addApprovalCommentSchema.parse({ body: 'Reviewed.' })).not.toThrow();
  });
});
