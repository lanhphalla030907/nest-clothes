import {
  validateNavigationRoute,
  SAFE_FALLBACK,
} from './push-navigation.js';

describe('validateNavigationRoute', () => {
  it('returns the safe fallback for null input', () => {
    expect(validateNavigationRoute(null)).toBe(SAFE_FALLBACK);
  });

  it('returns the safe fallback for undefined input', () => {
    expect(validateNavigationRoute(undefined)).toBe(SAFE_FALLBACK);
  });

  it('returns the safe fallback for an empty string', () => {
    expect(validateNavigationRoute('')).toBe(SAFE_FALLBACK);
  });

  it('accepts a relative path starting with /', () => {
    expect(validateNavigationRoute('/notifications')).toBe('/notifications');
    expect(validateNavigationRoute('/account/orders/123')).toBe(
      '/account/orders/123',
    );
    expect(validateNavigationRoute('/admin/orders/456')).toBe(
      '/admin/orders/456',
    );
  });

  it('rejects paths that do not start with /', () => {
    expect(validateNavigationRoute('notifications')).toBe(SAFE_FALLBACK);
    expect(validateNavigationRoute('account/orders/123')).toBe(SAFE_FALLBACK);
    expect(validateNavigationRoute('relative/path')).toBe(SAFE_FALLBACK);
  });

  it('rejects protocol-relative URLs', () => {
    expect(validateNavigationRoute('//evil.com/path')).toBe(SAFE_FALLBACK);
  });

  it('rejects backslashes', () => {
    expect(validateNavigationRoute('/notifications\\..\\escape')).toBe(
      SAFE_FALLBACK,
    );
  });

  it('rejects external URLs with a scheme', () => {
    expect(validateNavigationRoute('https://evil.com/')).toBe(SAFE_FALLBACK);
    expect(validateNavigationRoute('http://evil.com/')).toBe(SAFE_FALLBACK);
  });

  it('rejects javascript: scheme', () => {
    expect(validateNavigationRoute('javascript:alert(1)')).toBe(SAFE_FALLBACK);
  });

  it('rejects data: scheme', () => {
    expect(validateNavigationRoute('data:text/html,<script>')).toBe(
      SAFE_FALLBACK,
    );
  });

  it('rejects a colon before the first path segment (scheme-like)', () => {
    expect(validateNavigationRoute('/:evil')).toBe(SAFE_FALLBACK);
  });

  it('accepts query strings and fragments on relative paths', () => {
    expect(validateNavigationRoute('/notifications?unread=1')).toBe(
      '/notifications?unread=1',
    );
    expect(validateNavigationRoute('/account/orders/123#details')).toBe(
      '/account/orders/123#details',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(validateNavigationRoute('  /notifications  ')).toBe('/notifications');
  });
});
