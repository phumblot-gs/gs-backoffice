import { describe, it, expect } from 'vitest';
import { extractWorkflowCode } from './index.js';

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
