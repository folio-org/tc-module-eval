import { compareEurekaInterfaces, EUREKA_INCOMPARABLE, isEurekaInterfaceCompatible } from '../utils/eureka-interface-compatibility';

describe('Eureka interface compatibility parity', () => {
  const compatible = (provided: string, required: string) => isEurekaInterfaceCompatible(
    { id: 'users', version: provided }, { id: 'users', version: required }
  );

  it.each([
    ['1.2.3', '1.2', 1, true],
    ['1.2.3', '1.3', -2, false],
    ['1.3', '1.2.3', 2, true],
    ['2.0', '1.3 2.0', 0, true],
    ['2.0.1', '1.3 2.0', 1, true],
    ['1.2', '1.3 2.0', -2, false]
  ])('compares provider %s to requirement %s', (provided, required, comparison, expected) => {
    expect(compareEurekaInterfaces({ id: 'users', version: provided }, { id: 'users', version: required })).toBe(comparison);
    expect(compatible(provided, required)).toBe(expected);
  });

  it('uses only the first provider expression and the first matching required major', () => {
    expect(compatible('1.3 2.0', '2.0')).toBe(false);
    expect(compatible('1.5', '1.6 1.4')).toBe(false);
    expect(compatible('1.5', '2.0 1.4')).toBe(true);
  });

  it('stops at malformed alternatives and reproduces Java split/int parsing', () => {
    expect(compatible('2.0', 'bad 2.0')).toBe(false);
    expect(compatible('2.0', '1.0  2.0')).toBe(false);
    expect(compatible('+2.00.', '2.0')).toBe(true);
    expect(compareEurekaInterfaces({ id: 'a', version: '2.0' }, { id: 'b', version: '2.0' })).toBe(EUREKA_INCOMPARABLE);
    expect(compatible('2147483648.0', '2147483648.0')).toBe(false);
  });

  it('reproduces signed 32-bit overflow in Java int subtraction', () => {
    expect(compareEurekaInterfaces({ id: 'users', version: '1.2147483647' }, { id: 'users', version: '1.-1' })).toBe(-2);
    expect(compareEurekaInterfaces({ id: 'users', version: '1.-2147483648' }, { id: 'users', version: '1.1' })).toBe(2);
    expect(compareEurekaInterfaces({ id: 'users', version: '1.0.2147483647' }, { id: 'users', version: '1.0.-1' })).toBe(-1);
  });
});
