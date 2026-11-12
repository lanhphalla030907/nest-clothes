import { readMailConfig } from './email.config.js';
import { renderPasswordResetEmail } from './password-reset-email.template.js';

const PASSWORD = 'smtp-password-that-must-not-leak';
const completeEnv: NodeJS.ProcessEnv = {
  MAIL_HOST: 'smtp.example.test',
  MAIL_PORT: '587',
  MAIL_USER: 'mailer',
  MAIL_PASSWORD: PASSWORD,
  MAIL_FROM: 'CTRL Studio <no-reply@example.test>',
  FRONTEND_RESET_URL: 'https://shop.example.test/reset-password',
};

describe('readMailConfig', () => {
  it('resolves a complete configuration and defaults secure by port', () => {
    const config = readMailConfig(completeEnv);

    expect(config.configured).toBe(true);
    if (!config.configured) throw new Error('expected configured mail');
    expect(config.settings.host).toBe('smtp.example.test');
    expect(config.settings.port).toBe(587);
    expect(config.settings.secure).toBe(false);
    expect(config.missing).toEqual([]);
  });

  it('never serialises the SMTP password', () => {
    const config = readMailConfig(completeEnv);

    expect(JSON.stringify(config)).not.toContain(PASSWORD);
  });

  it('reports missing variables by name only', () => {
    const config = readMailConfig({});

    expect(config.configured).toBe(false);
    expect([...config.missing].sort()).toEqual([
      'FRONTEND_RESET_URL',
      'MAIL_FROM',
      'MAIL_HOST',
      'MAIL_PASSWORD',
      'MAIL_PORT',
      'MAIL_USER',
    ]);
    expect(JSON.stringify(config)).not.toContain(PASSWORD);
  });

  it('treats a blank password as missing', () => {
    const config = readMailConfig({ ...completeEnv, MAIL_PASSWORD: '   ' });

    expect(config.configured).toBe(false);
    expect(config.missing).toContain('MAIL_PASSWORD');
  });

  it('rejects an unusable port', () => {
    const config = readMailConfig({ ...completeEnv, MAIL_PORT: '70000' });

    expect(config.configured).toBe(false);
    expect(config.missing).toContain('MAIL_PORT');
  });

  it('rejects a non-http reset URL', () => {
    const config = readMailConfig({
      ...completeEnv,
      FRONTEND_RESET_URL: 'javascript:alert(1)',
    });

    expect(config.configured).toBe(false);
    expect(config.missing).toContain('FRONTEND_RESET_URL');
  });

  it('accepts an explicit secure flag', () => {
    const config = readMailConfig({
      ...completeEnv,
      MAIL_PORT: '465',
      MAIL_SECURE: 'true',
    });

    expect(config.configured).toBe(true);
    if (!config.configured) throw new Error('expected configured mail');
    expect(config.settings.secure).toBe(true);
  });
});

describe('renderPasswordResetEmail', () => {
  it('contains branding, the reset link, expiry and security notices', () => {
    const rendered = renderPasswordResetEmail({
      firstName: 'Ada',
      resetUrl: 'https://shop.example.test/reset-password?token=abc',
      expiresInMinutes: 15,
    });

    expect(rendered.subject).toContain('CTRL');
    expect(rendered.html).toContain('CTRL Studio');
    expect(rendered.html).toContain('Reset password');
    expect(rendered.html).toContain('expires in 15 minutes');
    expect(rendered.html).toContain('If you did not request this reset');
    expect(rendered.text).toContain(
      'https://shop.example.test/reset-password?token=abc',
    );
  });

  it('escapes the recipient name', () => {
    const rendered = renderPasswordResetEmail({
      firstName: '<script>alert(1)</script>',
      resetUrl: 'https://shop.example.test/reset-password?token=abc',
      expiresInMinutes: 15,
    });

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});
