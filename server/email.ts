import { Encounter, Patient } from "@shared/schema";

export interface EmailService {
  sendReferralNotification(encounter: Encounter, patient: Patient, notificationEmail: string): Promise<void>;
}

class MailgunEmailService implements EmailService {
  private apiKey: string;
  private domain: string;
  private fromEmail: string;

  constructor() {
    this.apiKey = process.env.MAILGUN_API_KEY || "";
    this.domain = process.env.MAILGUN_DOMAIN || "";
    this.fromEmail = process.env.MAILGUN_FROM_EMAIL || `noreply@${this.domain}`;
    
    if (!this.apiKey || !this.domain) {
      console.warn("[Mailgun] MAILGUN_API_KEY or MAILGUN_DOMAIN not configured. Email notifications will be disabled.");
    } else {
      console.log(`[Mailgun] Email service initialized with domain: ${this.domain}, from: ${this.fromEmail}`);
    }
  }

  async sendReferralNotification(encounter: Encounter, patient: Patient, notificationEmail: string): Promise<void> {
    if (!this.apiKey || !this.domain) {
      console.warn("Mailgun not configured. Skipping email notification.");
      return;
    }

    if (!notificationEmail) {
      console.warn("No notification email configured. Skipping email notification.");
      return;
    }

    // Clean up email list - split by comma, trim whitespace, filter empty
    const emails = notificationEmail
      .split(",")
      .map(e => e.trim())
      .filter(e => e.length > 0);
    
    if (emails.length === 0) {
      console.warn("No valid notification emails. Skipping email notification.");
      return;
    }

    const recipientList = emails.join(", ");

    try {
      const formData = new URLSearchParams();
      formData.append("from", `Patient Referral System <${this.fromEmail}>`);
      formData.append("to", recipientList);
      formData.append("subject", `New Referral Submitted - ${patient.firstName} ${patient.lastName}`);
      formData.append("html", `
        <h2>New Referral Submitted</h2>
        <p>A new referral has been submitted in the Patient Referral System.</p>
        
        <h3>Patient Information</h3>
        <ul>
          <li><strong>Name:</strong> ${patient.firstName} ${patient.lastName}</li>
          <li><strong>Date of Birth:</strong> ${new Date(patient.dateOfBirth).toLocaleDateString()}</li>
          <li><strong>Email:</strong> ${patient.email}</li>
          <li><strong>Phone:</strong> ${patient.phone}</li>
        </ul>
        
        <h3>Encounter Details</h3>
        <ul>
          <li><strong>Reference Number:</strong> ${encounter.referenceNumber}</li>
          <li><strong>Diagnosis:</strong> ${encounter.diagnosis}</li>
          <li><strong>Urgency:</strong> ${encounter.urgency.charAt(0).toUpperCase() + encounter.urgency.slice(1)}</li>
          ${encounter.icd10Code ? `<li><strong>ICD-10 Code:</strong> ${encounter.icd10Code}</li>` : ""}
          ${encounter.referringProvider ? `<li><strong>Referring Provider:</strong> ${encounter.referringProvider}</li>` : ""}
        </ul>
        
        ${
          encounter.insurancePlan || encounter.policyNumber || encounter.groupNumber
            ? `
              <h3>Insurance Information</h3>
              <ul>
                ${encounter.insurancePlan ? `<li><strong>Insurance Plan:</strong> ${encounter.insurancePlan}</li>` : ""}
                ${encounter.policyNumber ? `<li><strong>Policy Number:</strong> ${encounter.policyNumber}</li>` : ""}
                ${encounter.groupNumber ? `<li><strong>Group Number:</strong> ${encounter.groupNumber}</li>` : ""}
              </ul>
            `
            : ""
        }
        
        <p>Log in to the system to review and manage this referral.</p>
      `);

      console.log(`[Mailgun] Sending email to ${recipientList} (${emails.length} recipient(s)) from ${this.fromEmail}`);
      console.log(`[Mailgun] Domain: ${this.domain}`);
      console.log(`[Mailgun] API Key (first 10): ${this.apiKey.substring(0, 10)}...`);
      
      const response = await fetch(`https://api.mailgun.net/v3/${this.domain}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      });

      const responseText = await response.text();
      console.log(`[Mailgun] Response status: ${response.status}`);
      console.log(`[Mailgun] Response body: ${responseText}`);

      if (!response.ok) {
        throw new Error(`Mailgun API error: ${response.status} ${responseText}`);
      }

      console.log(`Email notification sent to ${emails.length} recipient(s) for referral ${encounter.referenceNumber}`);
    } catch (error) {
      console.error("Failed to send email notification:", error);
    }
  }
}

class MockEmailService implements EmailService {
  async sendReferralNotification(encounter: Encounter, patient: Patient, notificationEmail: string): Promise<void> {
    console.log(`[MOCK EMAIL] Would send notification to ${notificationEmail}`);
    console.log(`[MOCK EMAIL] Referral: ${encounter.referenceNumber} for patient ${patient.firstName} ${patient.lastName}`);
  }
}

export const emailService: EmailService = process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN
  ? new MailgunEmailService()
  : new MockEmailService();
