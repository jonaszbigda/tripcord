import type { Mail, Mailer } from "../src/email";

/** Records what would have been sent. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
