'use strict';

const {
  validateBalancedLines,
  normalizeBalance,
  postJournalEntry,
  UnbalancedEntryError,
  PeriodLockedError,
} = require('../../src/shared/glPosting');

describe('validateBalancedLines (pure)', () => {
  test('accepts a balanced two-line entry', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: 1000 },
        { accountId: 2, creditPesewas: 1000 },
      ])
    ).not.toThrow();
  });

  test('balances a multi-line entry (one debit split across several credits)', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: 1000 },
        { accountId: 2, creditPesewas: 700 },
        { accountId: 3, creditPesewas: 300 },
      ])
    ).not.toThrow();
  });

  test('rejects an unbalanced entry', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: 1000 },
        { accountId: 2, creditPesewas: 900 },
      ])
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects fewer than two lines', () => {
    expect(() => validateBalancedLines([{ accountId: 1, debitPesewas: 1000 }])).toThrow(UnbalancedEntryError);
  });

  test('rejects a line with both debit and credit set', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: 1000, creditPesewas: 1000 },
        { accountId: 2, creditPesewas: 1000 },
      ])
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects a line with neither debit nor credit set', () => {
    expect(() =>
      validateBalancedLines([{ accountId: 1 }, { accountId: 2, creditPesewas: 1000 }])
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects non-integer (float) amounts — money is never a float', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: 10.5 },
        { accountId: 2, creditPesewas: 10.5 },
      ])
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects negative amounts', () => {
    expect(() =>
      validateBalancedLines([
        { accountId: 1, debitPesewas: -1000 },
        { accountId: 2, creditPesewas: 1000 },
      ])
    ).toThrow(UnbalancedEntryError);
  });

  test('rejects a line missing accountId', () => {
    expect(() =>
      validateBalancedLines([{ debitPesewas: 1000 }, { accountId: 2, creditPesewas: 1000 }])
    ).toThrow(UnbalancedEntryError);
  });
});

describe('normalizeBalance (pure)', () => {
  test('asset and expense accounts are debit-normal', () => {
    expect(normalizeBalance('asset', 1000, 300)).toBe(700);
    expect(normalizeBalance('expense', 1000, 300)).toBe(700);
  });

  test('liability, equity, and income accounts are credit-normal', () => {
    expect(normalizeBalance('liability', 300, 1000)).toBe(700);
    expect(normalizeBalance('equity', 300, 1000)).toBe(700);
    expect(normalizeBalance('income', 300, 1000)).toBe(700);
  });
});

function makeMockPool(queryImpl) {
  const client = { query: jest.fn(queryImpl), release: jest.fn() };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  return { pool, client };
}

describe('postJournalEntry', () => {
  const validParams = {
    branchId: 1,
    reference: 'JV-1',
    entryDate: '2026-07-25',
    sourceModule: 'manual_jv',
    createdBy: 9,
    lines: [
      { accountId: 1, debitPesewas: 1000 },
      { accountId: 2, creditPesewas: 1000 },
    ],
  };

  test('rejects an unbalanced entry before ever opening a connection', async () => {
    const pool = { connect: jest.fn() };
    await expect(
      postJournalEntry(pool, {
        ...validParams,
        lines: [
          { accountId: 1, debitPesewas: 1000 },
          { accountId: 2, creditPesewas: 900 },
        ],
      })
    ).rejects.toThrow(UnbalancedEntryError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('rolls back and rethrows when the GL period is locked', async () => {
    const responses = [
      undefined, // BEGIN
      { rows: [{ id: 1 }] }, // assertPeriodOpen finds a locked period
    ];
    let call = 0;
    const { pool, client } = makeMockPool(() => Promise.resolve(responses[call++]));

    await expect(postJournalEntry(pool, validParams)).rejects.toThrow(PeriodLockedError);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('rolls back and releases the client when an insert fails', async () => {
    const responses = [
      undefined, // BEGIN
      { rows: [] }, // assertPeriodOpen: no locked period
      Promise.reject(new Error('unique violation')), // INSERT gl_journal_entries fails
    ];
    let call = 0;
    const { pool, client } = makeMockPool(() => {
      const r = responses[call++];
      return r instanceof Promise ? r : Promise.resolve(r);
    });

    await expect(postJournalEntry(pool, validParams)).rejects.toThrow('unique violation');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('posts header + lines + an audit log entry inside one transaction and commits', async () => {
    const entry = { id: 1, branch_id: 1 };
    const line1 = { id: 1 };
    const line2 = { id: 2 };
    const responses = [
      undefined, // BEGIN
      { rows: [] }, // assertPeriodOpen: no locked period
      { rows: [entry] }, // INSERT gl_journal_entries
      { rows: [line1] }, // INSERT line 1
      { rows: [line2] }, // INSERT line 2
      { rows: [{ id: 99 }] }, // audit log insert
      undefined, // COMMIT
    ];
    let call = 0;
    const { pool, client } = makeMockPool(() => Promise.resolve(responses[call++]));

    const result = await postJournalEntry(pool, validParams);

    expect(result.id).toBe(1);
    expect(result.lines).toEqual([line1, line2]);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
