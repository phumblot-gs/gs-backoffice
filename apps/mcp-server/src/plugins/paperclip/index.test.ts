import { describe, it, expect } from 'vitest';
import {
  extractWorkflowCode,
  isSensitiveProcess,
  summarizeRequest,
  missingRequiredVariables,
  approvalScopeResourceId,
} from './index.js';

describe('approvalScopeResourceId (audit scope never empty)', () => {
  it('uses approvalId (native approvals)', () => {
    expect(approvalScopeResourceId({ approvalId: 'appr-1', processCode: 'x' })).toBe('appr-1');
  });
  it('falls back to legacy ticketId', () => {
    expect(approvalScopeResourceId({ ticketId: 'GRA-9' })).toBe('GRA-9');
  });
  it('returns empty string when neither is present', () => {
    expect(approvalScopeResourceId({ processCode: 'x' })).toBe('');
  });
});

describe('summarizeRequest', () => {
  it('prefers the request param, then summary, then notes, then first param', () => {
    expect(summarizeRequest({ request: 'Add a rule' }, 'ignored notes')).toBe('Add a rule');
    expect(summarizeRequest({ summary: 'S' }, 'n')).toBe('S');
    expect(summarizeRequest(undefined, 'from notes')).toBe('from notes');
    expect(summarizeRequest({ foo: 'bar' }, undefined)).toBe('bar');
  });
  it('collapses whitespace and truncates long text', () => {
    expect(summarizeRequest({ request: 'a\n  b   c' }, undefined)).toBe('a b c');
    const long = 'x'.repeat(200);
    const out = summarizeRequest({ request: long }, undefined);
    expect(out.length).toBe(160);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty string when nothing is provided', () => {
    expect(summarizeRequest(undefined, undefined)).toBe('');
    expect(summarizeRequest({}, '')).toBe('');
  });
});

describe('missingRequiredVariables', () => {
  const routine = (variables: unknown) => ({ variables });
  it('flags a required variable with no value supplied', () => {
    expect(missingRequiredVariables(routine([{ name: 'request', required: true }]), {})).toEqual([
      'request',
    ]);
    expect(missingRequiredVariables(routine([{ name: 'request' }]), { request: '   ' })).toEqual([
      'request',
    ]); // default required=true, blank counts as missing
  });
  it('passes when the value is supplied', () => {
    expect(missingRequiredVariables(routine([{ name: 'request' }]), { request: 'do X' })).toEqual(
      [],
    );
  });
  it('ignores optional variables and those with a default', () => {
    expect(missingRequiredVariables(routine([{ name: 'x', required: false }]), {})).toEqual([]);
    expect(missingRequiredVariables(routine([{ name: 'x', defaultValue: 'd' }]), {})).toEqual([]);
  });
  it('handles routines with no variables', () => {
    expect(missingRequiredVariables(routine(undefined), {})).toEqual([]);
    expect(missingRequiredVariables(routine([]), undefined)).toEqual([]);
  });
});

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
