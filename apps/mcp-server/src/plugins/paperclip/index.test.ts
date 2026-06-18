import { describe, it, expect } from 'vitest';
import {
  extractWorkflowCode,
  isSensitiveProcess,
  buildApprovalDescription,
  parseApprovalDescription,
} from './index.js';

describe('isSensitiveProcess', () => {
  it('flags titles starting with ! (incl. leading space)', () => {
    expect(isSensitiveProcess('!Pay supplier (pay-supplier)')).toBe(true);
    expect(isSensitiveProcess('  !Pay supplier (pay-supplier)')).toBe(true);
  });
  it('does not flag normal titles', () => {
    expect(isSensitiveProcess('Register a contract (register-contract)')).toBe(false);
    expect(isSensitiveProcess(null)).toBe(false);
    expect(isSensitiveProcess(undefined)).toBe(false);
  });
});

describe('approval description round-trip', () => {
  it('builds a human description with an embedded machine-readable block, and parses it back', () => {
    const payload = {
      kind: 'gs-approval-request' as const,
      routineId: 'rt_123',
      processCode: 'pay-supplier',
      scope: 'finance' as string | null,
      requestedBy: 'alice@grand-shooting.com',
      parameters: { amount: '1000' },
    };
    const desc = buildApprovalDescription(payload);
    expect(desc).toContain('pay-supplier');
    expect(parseApprovalDescription(desc)).toEqual(payload);
  });

  it('returns null for a non-approval description', () => {
    expect(parseApprovalDescription('just a regular ticket')).toBeNull();
    expect(parseApprovalDescription(null)).toBeNull();
    expect(parseApprovalDescription('```json\n{"kind":"other"}\n```')).toBeNull();
  });
});

describe('extractWorkflowCode', () => {
  it('extracts a parenthesized code at the end of the title', () => {
    expect(extractWorkflowCode('Register a contract (register-contract)')).toBe(
      'register-contract',
    );
    expect(extractWorkflowCode('Invoice a client (invoice_client)')).toBe('invoice_client');
    expect(extractWorkflowCode('Prospect brief (PB1)')).toBe('PB1');
  });

  it('returns null for routines without a code (internal automations)', () => {
    expect(extractWorkflowCode('Automated PR Validation')).toBeNull();
    // a parenthesised label with a space is not a valid code
    expect(extractWorkflowCode('Automated PR Validation (PR validator)')).toBeNull();
    expect(extractWorkflowCode('')).toBeNull();
    expect(extractWorkflowCode(null)).toBeNull();
    expect(extractWorkflowCode(undefined)).toBeNull();
  });

  it('matches only a code anchored at the end of the title', () => {
    expect(extractWorkflowCode('Process (old) renamed (new-code)')).toBe('new-code');
    // mid-title parentheses without an end code → null
    expect(extractWorkflowCode('Process (mid) without trailing code here')).toBeNull();
  });
});
