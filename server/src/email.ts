import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends plain-text email. The server has one only when SMTP is configured. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface EmailConfig {
  /** nodemailer connection URL, e.g. smtps://user:pass@smtp.example.com:465 */
  smtpUrl: string;
  /** From header, e.g. "Tripcord <no-reply@tripcord.dev>" */
  from: string;
}

export function createSmtpMailer(config: EmailConfig): Mailer {
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    async send(mail) {
      await transport.sendMail({ from: config.from, ...mail });
    },
  };
}

// Plain text only: a greeting, one link, when it expires, and what to do if the
// reader didn't expect it. No templates, no HTML.

export function passwordResetMail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Reset your Tripcord password",
    text: [
      `Hi ${name},`,
      "",
      "Someone asked to reset the password of your Tripcord account. To choose a new one, open:",
      "",
      link,
      "",
      "The link works once, for one hour.",
      "",
      "If you didn't ask for this, ignore this email. Your password stays as it is.",
    ].join("\n"),
  };
}

export function signupInviteMail(to: string, link: string, expiresAt: Date): Mail {
  return {
    to,
    subject: "You're invited to Tripcord",
    text: [
      "Hi,",
      "",
      "You're invited to the Tripcord beta. To create your account, open:",
      "",
      link,
      "",
      `The link works once, until ${expiresAt.toISOString().slice(0, 10)}.`,
      "",
      "If you weren't expecting this, ignore this email.",
    ].join("\n"),
  };
}

export function verifyEmailMail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Confirm your Tripcord email",
    text: [
      `Hi ${name},`,
      "",
      "To finish signing up for Tripcord, confirm your email address:",
      "",
      link,
      "",
      "This link expires in 24 hours. If you didn't sign up for Tripcord, ignore this",
      "email and the account will be deleted in 7 days.",
    ].join("\n"),
  };
}
