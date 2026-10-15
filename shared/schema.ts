import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, index, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Patients table - Core patient profile/demographics
export const patients = pgTable("patients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Demographics
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: text("date_of_birth").notNull(),
  gender: varchar("gender").notNull(),
  
  // Contact Information
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  primaryLanguage: text("primary_language"),

  // Address (also the insurance subscriber address — OpenEMR requires it)
  street: text("street"),
  city: text("city"),
  state: varchar("state", { length: 2 }),
  postalCode: varchar("postal_code", { length: 10 }),

  // Insurance Information (stored at patient level)
  insurancePlan: text("insurance_plan"),
  policyNumber: text("policy_number"),
  groupNumber: text("group_number"),
  effectiveDate: text("effective_date"),
  
  // OpenEMR Patient Integration (one patient = one OpenEMR patient)
  openemrPatientId: varchar("openemr_patient_id").unique(),
  openemrPatientPid: varchar("openemr_patient_pid"),
  lastSyncedAt: timestamp("last_synced_at"),
  
  // Deduplication fingerprint (normalized name + DOB for matching)
  dedupeFingerprint: varchar("dedupe_fingerprint").notNull(),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_patients_dedupe").on(table.dedupeFingerprint),
  index("idx_patients_openemr").on(table.openemrPatientId),
]);

export const insertPatientSchema = createInsertSchema(patients).omit({
  id: true,
  openemrPatientId: true,
  openemrPatientPid: true,
  lastSyncedAt: true,
  dedupeFingerprint: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  dateOfBirth: z.string().min(1, "Date of birth is required"),
  gender: z.enum(['male', 'female', 'other']),
  email: z.string().email("Valid email is required"),
  phone: z.string().min(1, "Phone number is required"),
  primaryLanguage: z.string().optional(),
  street: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "" || /^[A-Z]{2}$/.test(s), "Use the 2-letter state code")
    .optional(),
  postalCode: z
    .string()
    .trim()
    .refine((s) => s === "" || /^\d{5}(-\d{4})?$/.test(s), "ZIP is 5 digits (or ZIP+4)")
    .optional(),
  insurancePlan: z.string().optional(),
  policyNumber: z.string().optional(),
  groupNumber: z.string().optional(),
  effectiveDate: z.string().optional(),
});

export type InsertPatient = z.infer<typeof insertPatientSchema>;
export type Patient = typeof patients.$inferSelect;

// Encounters table - Referral details (medical encounter/episode)
export const encounters = pgTable("encounters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  referenceNumber: varchar("reference_number").notNull().unique(),
  
  // Links to patient and user
  patientId: varchar("patient_id").notNull().references(() => patients.id),
  userId: varchar("user_id").notNull(),
  
  // Medical Details
  diagnosis: text("diagnosis").notNull(),
  encounterType: text("encounter_type"),
  urgency: varchar("urgency").notNull(),
  medicalHistory: text("medical_history"),
  currentMedications: text("current_medications"),
  icd10Code: text("icd10_code"),
  referralReason: text("referral_reason"),
  
  // Insurance Information
  insurancePlan: text("insurance_plan"),
  policyNumber: text("policy_number"),
  groupNumber: text("group_number"),
  effectiveDate: text("effective_date"),
  insuranceEndDate: text("insurance_end_date"),
  // Policy holder; the patient's own name/DOB/sex are used when "self"
  subscriberRelationship: varchar("subscriber_relationship"), // self | spouse | child | other
  subscriberFirstName: text("subscriber_first_name"),
  subscriberLastName: text("subscriber_last_name"),
  subscriberDob: text("subscriber_dob"),
  subscriberSex: varchar("subscriber_sex"),
  subscriberSsn: varchar("subscriber_ssn", { length: 11 }), // stripped from API responses
  // Subscriber address; empty means "same as patient"
  subscriberStreet: text("subscriber_street"),
  subscriberCity: text("subscriber_city"),
  subscriberState: varchar("subscriber_state", { length: 2 }),
  subscriberPostalCode: varchar("subscriber_postal_code", { length: 10 }),
  acceptAssignment: boolean("accept_assignment").default(true),

  // Referring Provider
  referringProvider: text("referring_provider").notNull(),
  providerContact: text("provider_contact").notNull(),
  // Optional; when given, the provider is linked to OpenEMR's Address Book by NPI
  referringProviderNpi: varchar("referring_provider_npi", { length: 10 }),

  // Status
  status: varchar("status").notNull().default('submitted'),

  // OpenEMR Encounter Integration (many encounters per patient)
  openemrEncounterId: varchar("openemr_encounter_id"),
  openemrPractitioner: text("openemr_practitioner"),
  openemrPractitionerId: text("openemr_practitioner_id"),
  openemrDocumentIds: text("openemr_document_ids").array().default(sql`ARRAY[]::text[]`),
  syncStatus: varchar("sync_status").notNull().default('not_synced'),
  lastSyncedAt: timestamp("last_synced_at"),
  syncError: text("sync_error"),
  
  // Timestamps
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
}, (table) => [
  index("idx_encounters_patient").on(table.patientId),
  index("idx_encounters_user").on(table.userId),
  index("idx_encounters_reference").on(table.referenceNumber),
]);

// Files attached to a referral. Uploaded before the referral is submitted
// (encounterId is null until then), then sent to the patient's chart in OpenEMR.
// Content is base64 text so it works with both database drivers.
export const encounterDocuments = pgTable("encounter_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  encounterId: varchar("encounter_id").references(() => encounters.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull(),
  fileName: text("file_name").notNull(),
  contentType: varchar("content_type").notNull(),
  size: integer("size").notNull(),
  content: text("content").notNull(),
  openemrSyncStatus: varchar("openemr_sync_status").notNull().default("pending"), // pending | synced | failed
  openemrSyncError: text("openemr_sync_error"),
  openemrSyncedAt: timestamp("openemr_synced_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_encounter_documents_encounter").on(table.encounterId),
]);

export type EncounterDocument = typeof encounterDocuments.$inferSelect;
// What the API returns: everything except the file content
export type EncounterDocumentInfo = Omit<EncounterDocument, "content">;

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MAX_FILES = 10;
export const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tif",
  "image/heic": ".heic",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
};

export const insertEncounterSchema = createInsertSchema(encounters).omit({
  id: true,
  referenceNumber: true,
  submittedAt: true,
  userId: true,
  patientId: true,
  openemrEncounterId: true,
  openemrPractitioner: true,
  openemrPractitionerId: true,
  openemrDocumentIds: true,
  syncStatus: true,
  lastSyncedAt: true,
  syncError: true,
}).extend({
  diagnosis: z.string().min(1, "Diagnosis is required"),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  medicalHistory: z.string().optional(),
  currentMedications: z.string().optional(),
  icd10Code: z.string().optional(),
  referralReason: z.string().optional(),
  insurancePlan: z.string().optional(),
  policyNumber: z.string().optional(),
  groupNumber: z.string().optional(),
  effectiveDate: z.string().optional(),
  insuranceEndDate: z.string().optional(),
  subscriberRelationship: z.enum(['self', 'spouse', 'child', 'other']).optional(),
  subscriberFirstName: z.string().trim().optional(),
  subscriberLastName: z.string().trim().optional(),
  subscriberDob: z.string().optional(),
  subscriberSex: z.enum(['male', 'female', 'other']).optional(),
  // Stored as XXX-XX-XXXX, the form OpenEMR compares against
  subscriberSsn: z
    .string()
    .trim()
    .transform((s) => s.replace(/\D/g, ""))
    .refine((s) => s === "" || s.length === 9, "SSN is 9 digits")
    .transform((s) => (s ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : ""))
    .optional(),
  subscriberStreet: z.string().trim().optional(),
  subscriberCity: z.string().trim().optional(),
  subscriberState: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "" || /^[A-Z]{2}$/.test(s), "Use the 2-letter state code")
    .optional(),
  subscriberPostalCode: z
    .string()
    .trim()
    .refine((s) => s === "" || /^\d{5}(-\d{4})?$/.test(s), "ZIP is 5 digits (or ZIP+4)")
    .optional(),
  acceptAssignment: z.boolean().optional(), // unset = yes (column default)
  referringProvider: z.string().min(1, "Referring provider is required"),
  providerContact: z.string().min(1, "Provider contact is required"),
  referringProviderNpi: z
    .string()
    .trim()
    .refine((s) => s === "" || isValidNpi(s), "Enter a valid 10-digit NPI")
    .transform((s) => s || null)
    .optional()
    .nullable(),
  status: z.string().default('submitted'),
});

export type InsertEncounter = z.infer<typeof insertEncounterSchema>;
export type Encounter = typeof encounters.$inferSelect;

// Legacy referrals table - keeping for backwards compatibility during migration
export const referrals = pgTable("referrals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  referenceNumber: varchar("reference_number").notNull().unique(),
  userId: varchar("user_id").notNull(),
  
  // Patient Information
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: text("date_of_birth").notNull(),
  gender: varchar("gender").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  
  // Medical Details
  diagnosis: text("diagnosis").notNull(),
  urgency: varchar("urgency").notNull(),
  medicalHistory: text("medical_history"),
  currentMedications: text("current_medications"),
  icd10Code: text("icd10_code"),
  referralReason: text("referral_reason"),
  
  // Insurance Information
  insurancePlan: text("insurance_plan"),
  policyNumber: text("policy_number"),
  groupNumber: text("group_number"),
  effectiveDate: text("effective_date"),
  
  // Additional Information
  primaryLanguage: text("primary_language"),
  
  // Referring Provider
  referringProvider: text("referring_provider").notNull(),
  providerContact: text("provider_contact").notNull(),
  
  // Status
  status: varchar("status").notNull().default('submitted'),
  
  // OpenEMR Integration
  openemrPatientId: varchar("openemr_patient_id"),
  openemrPatientPid: varchar("openemr_patient_pid"),
  openemrEncounterId: varchar("openemr_encounter_id"),
  openemrDocumentIds: text("openemr_document_ids").array().default(sql`ARRAY[]::text[]`),
  syncStatus: varchar("sync_status").notNull().default('not_synced'),
  lastSyncedAt: timestamp("last_synced_at"),
  syncError: text("sync_error"),
  
  // Timestamps
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
});

export const insertReferralSchema = createInsertSchema(referrals).omit({
  id: true,
  referenceNumber: true,
  submittedAt: true,
  userId: true,
  openemrPatientId: true,
  openemrPatientPid: true,
  openemrEncounterId: true,
  syncStatus: true,
  lastSyncedAt: true,
  syncError: true,
}).extend({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  dateOfBirth: z.string().min(1, "Date of birth is required"),
  gender: z.enum(['male', 'female', 'other']),
  email: z.string().email("Valid email is required"),
  phone: z.string().min(1, "Phone number is required"),
  diagnosis: z.string().min(1, "Diagnosis is required"),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  medicalHistory: z.string().optional(),
  currentMedications: z.string().optional(),
  icd10Code: z.string().optional(),
  referralReason: z.string().optional(),
  insurancePlan: z.string().optional(),
  policyNumber: z.string().optional(),
  groupNumber: z.string().optional(),
  effectiveDate: z.string().optional(),
  primaryLanguage: z.string().optional(),
  referringProvider: z.string().min(1, "Referring provider is required"),
  providerContact: z.string().min(1, "Provider contact is required"),
  status: z.string().default('submitted'),
});

export type InsertReferral = z.infer<typeof insertReferralSchema>;
export type Referral = typeof referrals.$inferSelect;

// Session storage table for Replit Auth
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table for authentication
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  username: varchar("username").unique(),
  passwordHash: varchar("password_hash"),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  isAdmin: boolean("is_admin").default(false),
  isActive: boolean("is_active").default(true),

  // Referring provider profile (non-admin accounts only).
  // Uniqueness of NPI is enforced in code, not with a DB constraint, so that
  // `drizzle-kit push` never stops to ask questions during container start.
  npi: varchar("npi", { length: 10 }),
  credential: varchar("credential"),
  specialty: text("specialty"),
  practiceName: text("practice_name"),
  phone: varchar("phone"),
  fax: varchar("fax"),
  street: text("street"),
  city: text("city"),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 10 }),

  // Link to the OpenEMR Address Book entry for this provider
  openemrProviderId: varchar("openemr_provider_id"),
  openemrProviderUuid: varchar("openemr_provider_uuid"),
  openemrSyncStatus: varchar("openemr_sync_status"), // 'synced' | 'failed' | null (admins)
  openemrSyncError: text("openemr_sync_error"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_users_npi").on(table.npi),
]);

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// Login schema for authentication
export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

// Create user schema for admin
export const createUserSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  email: z.string().email("Valid email is required").optional(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  isAdmin: z.boolean().default(false),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

// NPI check digit: Luhn over "80840" + the 10 NPI digits
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = ("80840" + npi).split("").map(Number);
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const npiSchema = z
  .string()
  .trim()
  .regex(/^\d{10}$/, "NPI is 10 digits")
  .refine(isValidNpi, "That isn't a valid NPI number");

// Self-registration for referring providers
export const registerDoctorSchema = z
  .object({
    npi: npiSchema,
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    credential: z.string().trim().optional(),
    specialty: z.string().trim().min(1, "Specialty is required"),
    practiceName: z.string().trim().optional(),
    street: z.string().trim().min(1, "Street address is required"),
    city: z.string().trim().min(1, "City is required"),
    state: z
      .string()
      .trim()
      .length(2, "Use the 2-letter state code")
      .transform((s) => s.toUpperCase()),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP is 5 digits (or ZIP+4)"),
    phone: z.string().trim().min(10, "Office phone is required"),
    fax: z.string().trim().optional(),
    email: z.string().trim().toLowerCase().email("Valid email is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type RegisterDoctorInput = z.infer<typeof registerDoctorSchema>;

// Update user schema for admin
export const updateUserSchema = z.object({
  email: z.string().email("Valid email is required").optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// System settings table (singleton pattern - only one row)
export const systemSettings = pgTable("system_settings", {
  id: varchar("id").primaryKey().default("singleton"),
  notificationEmail: text("notification_email"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// OpenEMR OAuth refresh token (singleton). Kept in its own table so it is never
// returned by the settings API, and so the connection survives container restarts.
export const openemrTokens = pgTable("openemr_tokens", {
  id: varchar("id").primaryKey().default("singleton"),
  refreshToken: text("refresh_token"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// OpenEMR OAuth client (singleton), created by the setup wizard through OpenEMR's
// dynamic client registration. Never returned to the browser: it holds the secret.
export const openemrClient = pgTable("openemr_client", {
  id: varchar("id").primaryKey().default("singleton"),
  baseUrl: text("base_url").notNull(),
  appUrl: text("app_url").notNull(),
  clientName: text("client_name").notNull(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type OpenEMRClient = typeof openemrClient.$inferSelect;

// Named counters (e.g. placeholder SSN sequence). Incremented atomically.
export const counters = pgTable("counters", {
  name: varchar("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

export const updateSystemSettingsSchema = z.object({
  notificationEmail: z.string().email("Valid email is required").optional(),
});

export type UpdateSystemSettings = z.infer<typeof updateSystemSettingsSchema>;

// First-run setup: the clinic's first admin account
export const setupAdminSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    email: z.string().trim().toLowerCase().email("Valid email is required"),
    username: z.string().trim().min(3, "Username must be at least 3 characters"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type SetupAdminInput = z.infer<typeof setupAdminSchema>;

// First-run setup: register this app as an OAuth client in OpenEMR
const urlField = (label: string) =>
  z
    .string()
    .trim()
    .url(`${label} must be a full URL, like https://example.com`)
    .refine((u) => /^https?:\/\//.test(u), `${label} must start with http:// or https://`)
    .transform((u) => u.replace(/\/+$/, ""));

export const setupOpenEMRSchema = z.object({
  openemrUrl: urlField("OpenEMR address"),
  appUrl: urlField("This app's address"),
  clientName: z.string().trim().min(1, "Application name is required"),
});

export type SetupOpenEMRInput = z.infer<typeof setupOpenEMRSchema>;

// Combined type for creating a referral (patient + encounter in one form)
export type CreateReferralInput = InsertPatient & InsertEncounter;
