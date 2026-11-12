export interface PasswordResetEmailInput {
  firstName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The password-reset email, kept as a pure function so it can be rendered in a
 * test without an SMTP connection.
 */
export function renderPasswordResetEmail({
  firstName,
  resetUrl,
  expiresInMinutes,
}: PasswordResetEmailInput): RenderedEmail {
  const name = firstName.trim().length > 0 ? firstName.trim() : 'there';
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);

  const subject = 'Reset your CTRL password';

  const text = [
    `Hi ${name},`,
    '',
    'We received a request to reset the password for your CTRL account.',
    `Open this link to choose a new password: ${resetUrl}`,
    '',
    `This link expires in ${expiresInMinutes} minutes and can be used once.`,
    '',
    'If you did not request this, you can ignore this email. Your password will not change.',
    '',
    'CTRL Studio',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f1ea;color:#141414;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ea;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #ded9cf;">
            <tr>
              <td style="padding:32px 32px 8px;letter-spacing:0.18em;font-size:11px;text-transform:uppercase;color:#6f6a61;">CTRL Studio</td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <h1 style="margin:0;font-size:26px;line-height:1.2;font-weight:600;color:#141414;">Reset your password</h1>
                <p style="margin:16px 0 0;font-size:15px;line-height:1.65;color:#4d4a44;">Hi ${safeName}, we received a request to reset the password for your CTRL account.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;">
                <a href="${safeUrl}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:15px 24px;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Reset password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;">
                <p style="margin:0;font-size:13px;line-height:1.65;color:#6f6a61;">This link expires in ${expiresInMinutes} minutes and can be used only once.</p>
                <p style="margin:12px 0 0;font-size:13px;line-height:1.65;color:#6f6a61;">If the button does not work, copy this address into your browser:</p>
                <p style="margin:8px 0 0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${safeUrl}" style="color:#141414;">${safeUrl}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px;border-top:1px solid #ded9cf;">
                <p style="margin:0;font-size:12px;line-height:1.65;color:#6f6a61;">If you did not request this reset, you can ignore this email. Your password will not change, and no one else can use this link without access to your inbox.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
