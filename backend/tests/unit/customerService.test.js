'use strict';

const {
  validateGhanaCardNo,
  validateCustomerFields,
  isValidDirectStatusTransition,
  CustomerValidationError,
} = require('../../src/modules/customer/customerService');

describe('validateGhanaCardNo (pure)', () => {
  test('accepts a valid card and uppercases it', () => {
    expect(validateGhanaCardNo('gha-123456789-1')).toBe('GHA-123456789-1');
  });

  test('rejects missing dashes', () => {
    expect(() => validateGhanaCardNo('GHA1234567891')).toThrow(CustomerValidationError);
  });

  test('rejects wrong digit counts', () => {
    expect(() => validateGhanaCardNo('GHA-12345-1')).toThrow(CustomerValidationError);
    expect(() => validateGhanaCardNo('GHA-1234567890-1')).toThrow(CustomerValidationError);
  });

  test('rejects a missing check digit', () => {
    expect(() => validateGhanaCardNo('GHA-123456789-')).toThrow(CustomerValidationError);
  });

  test('rejects empty/missing input', () => {
    expect(() => validateGhanaCardNo('')).toThrow(CustomerValidationError);
    expect(() => validateGhanaCardNo(undefined)).toThrow(CustomerValidationError);
  });
});

describe('validateCustomerFields (pure)', () => {
  test('individual requires fullName, branchId, and ghanaCardNo', () => {
    expect(() => validateCustomerFields('individual', { fullName: 'Ama', branchId: 1, ghanaCardNo: 'x' })).not.toThrow();
    expect(() => validateCustomerFields('individual', { branchId: 1, ghanaCardNo: 'x' })).toThrow(/fullName/);
    expect(() => validateCustomerFields('individual', { fullName: 'Ama', branchId: 1 })).toThrow(/ghanaCardNo/);
  });

  test('sme requires fullName, branchId, businessRegistrationNo, and contactPersonName', () => {
    expect(() =>
      validateCustomerFields('sme', {
        fullName: 'Kojo Traders',
        branchId: 1,
        businessRegistrationNo: 'BN-1',
        contactPersonName: 'Kojo',
      })
    ).not.toThrow();
    expect(() => validateCustomerFields('sme', { fullName: 'Kojo Traders', branchId: 1 })).toThrow(
      /businessRegistrationNo.*contactPersonName/
    );
  });

  test('rejects customer_type "group" — groups are created via createGroup(), not createCustomer()', () => {
    expect(() => validateCustomerFields('group', { fullName: 'A Group', branchId: 1 })).toThrow(/createGroup/);
  });

  test('rejects an unknown customer_type', () => {
    expect(() => validateCustomerFields('robot', { fullName: 'X', branchId: 1 })).toThrow(CustomerValidationError);
  });
});

describe('isValidDirectStatusTransition (pure)', () => {
  test('active and inactive can toggle directly', () => {
    expect(isValidDirectStatusTransition('active', 'inactive')).toBe(true);
    expect(isValidDirectStatusTransition('inactive', 'active')).toBe(true);
  });

  test('closed cannot be reached or left via a direct transition', () => {
    expect(isValidDirectStatusTransition('active', 'closed')).toBe(false);
    expect(isValidDirectStatusTransition('inactive', 'closed')).toBe(false);
    expect(isValidDirectStatusTransition('closed', 'active')).toBe(false);
    expect(isValidDirectStatusTransition('closed', 'inactive')).toBe(false);
  });

  test('rejects an unknown status', () => {
    expect(isValidDirectStatusTransition('active', 'bogus')).toBe(false);
  });
});
