export interface Mailer {
  sendInvitation(email: string, token: string, expiresAt: string): Promise<void>;
  sendRecovery(email: string, token: string, expiresAt: string): Promise<void>;
}

/** The local transport. Production wires the deployment SMTP relay here. */
export class ConsoleMailer implements Mailer {
  async sendInvitation(email: string, token: string, expiresAt: string): Promise<void> {
    console.info(`[mail] invitation for ${email}: ${token} (expires ${expiresAt})`);
  }

  async sendRecovery(email: string, token: string, expiresAt: string): Promise<void> {
    console.info(`[mail] recovery for ${email}: ${token} (expires ${expiresAt})`);
  }
}
