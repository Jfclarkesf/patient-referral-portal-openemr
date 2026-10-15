import { 
  type Referral, type InsertReferral, referrals,
  type Patient, type InsertPatient, patients,
  type Encounter, type InsertEncounter, encounters,
  type User, type UpsertUser, users,
  type SystemSettings, systemSettings, openemrTokens, counters,
  type OpenEMRClient, openemrClient,
  type EncounterDocument, type EncounterDocumentInfo, encounterDocuments,
  type CreateUserInput, type UpdateUserInput, type RegisterDoctorInput
} from "@shared/schema";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pkg from 'pg';
const { Pool } = pkg;
import { eq, ne, sql, like, and, inArray, isNull, lt } from "drizzle-orm";

// Helper function to create patient deduplication fingerprint
function createDedupeFingerprint(firstName: string, lastName: string, dateOfBirth: string): string {
  const normalizedFirst = firstName.toLowerCase().trim();
  const normalizedLast = lastName.toLowerCase().trim();
  const normalizedDOB = dateOfBirth.trim();
  return `${normalizedFirst}|${normalizedLast}|${normalizedDOB}`;
}

export interface IStorage {
  // User operations (required for Replit Auth)
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  makeUserAdmin(email: string): Promise<User>;
  upsertUser(user: UpsertUser): Promise<User>;
  
  // User management (for standalone mode)
  getAllUsers(): Promise<User[]>;
  createUserWithPassword(input: CreateUserInput): Promise<User>;
  updateUserById(id: string, input: UpdateUserInput): Promise<User>;
  deleteUserById(id: string): Promise<void>;
  verifyUserPassword(username: string, password: string): Promise<User | null>;

  // Referring provider self-registration
  getUserByNpi(npi: string): Promise<User | undefined>;
  createDoctorUser(input: RegisterDoctorInput): Promise<User>;
  updateUserOpenEMRProvider(
    id: string,
    link: { providerId: string | null; providerUuid: string | null; status: string; error: string | null }
  ): Promise<void>;
  
  // Patient operations
  createPatient(patient: InsertPatient): Promise<Patient>;
  getPatientById(id: string): Promise<Patient | undefined>;
  findPatientByOpenEMRId(openemrPatientId: string): Promise<Patient | undefined>;
  findPatientsByName(searchTerm: string): Promise<Patient[]>;
  findDuplicatePatients(firstName: string, lastName: string, dateOfBirth: string): Promise<Patient[]>;
  updatePatientOpenEMRIds(id: string, patientFhirId: string, patientPid: string): Promise<void>;
  getAllPatients(): Promise<Patient[]>;
  getPatientsForUser(userId: string): Promise<Patient[]>;
  deleteOrphanedPatients(): Promise<number>;
  
  // Encounter operations
  createEncounter(encounter: InsertEncounter, patientId: string, userId: string): Promise<Encounter>;
  getEncounterById(id: string): Promise<Encounter | undefined>;
  getEncounterByReferenceNumber(referenceNumber: string): Promise<Encounter | undefined>;
  findEncounterByOpenEMRId(openemrEncounterId: string): Promise<Encounter | undefined>;
  getEncountersByPatientId(patientId: string): Promise<Encounter[]>;
  getEncountersByUserId(userId: string): Promise<Encounter[]>;
  getAllEncounters(): Promise<Encounter[]>;
  updateEncounterOpenEMRIds(id: string, encounterId: string | null): Promise<void>;
  updateEncounterPractitionerInfo(id: string, practitioner: string | null, practitionerId: string | null): Promise<void>;
  updateEncounterDocumentIds(id: string, documentIds: string[]): Promise<void>;
  updateEncounterSyncStatus(id: string, syncStatus: string, syncError: string | null): Promise<void>;
  updateEncounterSubmittedAt(id: string, submittedAt: Date): Promise<void>;
  deleteEncounterById(id: string): Promise<void>;
  deleteEncountersByIds(ids: string[]): Promise<number>;
  
  // Legacy referral operations (backward compatibility)
  createReferral(referral: InsertReferral, userId: string): Promise<Referral>;
  getAllReferrals(): Promise<Referral[]>;
  getReferralsByUserId(userId: string): Promise<Referral[]>;
  getReferralByReferenceNumber(referenceNumber: string): Promise<Referral | undefined>;
  getReferralById(id: string): Promise<Referral | undefined>;
  updateReferralOpenEMRIds(id: string, patientFhirId: string, patientPid: string, encounterId: string | null): Promise<void>;
  updateReferralDocumentIds(id: string, documentIds: string[]): Promise<void>;
  clearReferralOpenEMRIds(id: string): Promise<void>;
  updateReferralSyncStatus(id: string, syncStatus: string, syncError: string | null): Promise<void>;
  
  // Settings operations
  getSystemSettings(): Promise<SystemSettings | undefined>;
  updateSystemSettings(notificationEmail: string | null): Promise<SystemSettings>;

  // OpenEMR token persistence
  getOpenEMRRefreshToken(): Promise<string | null>;
  saveOpenEMRRefreshToken(refreshToken: string | null): Promise<void>;

  // OpenEMR OAuth client registered by the setup wizard
  getOpenEMRClient(): Promise<OpenEMRClient | undefined>;
  saveOpenEMRClient(client: Omit<OpenEMRClient, "id" | "updatedAt">): Promise<OpenEMRClient>;

  hasAdminUser(): Promise<boolean>;

  // Referral documents
  createDocument(doc: { userId: string; fileName: string; contentType: string; size: number; content: string }): Promise<EncounterDocumentInfo>;
  getDocument(id: string): Promise<EncounterDocument | undefined>;
  getDocumentsForEncounter(encounterId: string): Promise<EncounterDocumentInfo[]>;
  getUnsyncedDocumentsForEncounter(encounterId: string): Promise<EncounterDocument[]>;
  attachDocumentsToEncounter(ids: string[], userId: string, encounterId: string): Promise<number>;
  deleteUnattachedDocument(id: string, userId: string): Promise<boolean>;
  updateDocumentSync(id: string, status: "synced" | "failed", error: string | null): Promise<void>;
  deleteStaleUnattachedDocuments(olderThan: Date): Promise<void>;
  nextCounterValue(name: string): Promise<number>;
}

export class DbStorage implements IStorage {
  private db;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set. Please configure PostgreSQL database connection.");
    }
    
    // Use standard PostgreSQL driver for Docker/standalone deployments
    // Neon HTTP driver for Replit deployments
    const isStandalone = process.env.STANDALONE_MODE === 'true' || !process.env.REPL_ID || process.env.REPL_ID === 'standalone-deployment';
    
    if (isStandalone) {
      // Use node-postgres for local PostgreSQL container
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      });
      this.db = drizzlePg(pool);
      console.log('✅ Using PostgreSQL driver for standalone deployment');
    } else {
      // Use Neon serverless for Replit
      const sql = neon(process.env.DATABASE_URL);
      this.db = drizzle(sql);
      console.log('✅ Using Neon HTTP driver for Replit deployment');
    }
  }

  // User operations (required for Replit Auth)
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return user;
  }

  async makeUserAdmin(email: string): Promise<User> {
    const [user] = await this.db
      .update(users)
      .set({ isAdmin: true, updatedAt: new Date() })
      .where(eq(users.email, email))
      .returning();
    
    if (!user) {
      throw new Error(`User with email ${email} not found`);
    }
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.email,
        set: {
          firstName: userData.firstName,
          lastName: userData.lastName,
          profileImageUrl: userData.profileImageUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  // User management methods for standalone mode
  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await this.db.select().from(users);
  }

  async createUserWithPassword(input: CreateUserInput): Promise<User> {
    const passwordHash = await bcrypt.hash(input.password, 10);
    const userId = randomUUID();
    
    const [user] = await this.db
      .insert(users)
      .values({
        id: userId,
        username: input.username,
        email: input.email || null,
        passwordHash,
        firstName: input.firstName || null,
        lastName: input.lastName || null,
        isAdmin: input.isAdmin || false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    
    return user;
  }

  async updateUserById(id: string, input: UpdateUserInput): Promise<User> {
    const updateData: Partial<UpsertUser> & { passwordHash?: string } = {
      updatedAt: new Date(),
    };

    if (input.email !== undefined) updateData.email = input.email;
    if (input.firstName !== undefined) updateData.firstName = input.firstName;
    if (input.lastName !== undefined) updateData.lastName = input.lastName;
    if (input.isAdmin !== undefined) updateData.isAdmin = input.isAdmin;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.password) {
      updateData.passwordHash = await bcrypt.hash(input.password, 10);
    }

    const [user] = await this.db
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning();
    
    if (!user) {
      throw new Error(`User with id ${id} not found`);
    }
    return user;
  }

  async deleteUserById(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }

  async verifyUserPassword(username: string, password: string): Promise<User | null> {
    const user = await this.getUserByUsername(username);
    if (!user || !user.passwordHash || !user.isActive) {
      return null;
    }
    
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return null;
    }
    
    return user;
  }

  // Referring provider self-registration
  async getUserByNpi(npi: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.npi, npi));
    return user;
  }

  async createDoctorUser(input: RegisterDoctorInput): Promise<User> {
    const passwordHash = await bcrypt.hash(input.password, 10);

    const [user] = await this.db
      .insert(users)
      .values({
        id: randomUUID(),
        username: input.email, // doctors sign in with their email
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        isAdmin: false,
        isActive: false, // waits for staff approval
        npi: input.npi,
        credential: input.credential || null,
        specialty: input.specialty,
        practiceName: input.practiceName || null,
        phone: input.phone,
        fax: input.fax || null,
        street: input.street,
        city: input.city,
        state: input.state,
        zip: input.zip,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return user;
  }

  async updateUserOpenEMRProvider(
    id: string,
    link: { providerId: string | null; providerUuid: string | null; status: string; error: string | null }
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        openemrProviderId: link.providerId,
        openemrProviderUuid: link.providerUuid,
        openemrSyncStatus: link.status,
        openemrSyncError: link.error,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
  }

  // Patient operations
  async createPatient(insertPatient: InsertPatient): Promise<Patient> {
    const fingerprint = createDedupeFingerprint(
      insertPatient.firstName,
      insertPatient.lastName,
      insertPatient.dateOfBirth
    );
    
    const [patient] = await this.db
      .insert(patients)
      .values({
        ...insertPatient,
        dedupeFingerprint: fingerprint,
      })
      .returning();
    
    return patient;
  }

  async getPatientById(id: string): Promise<Patient | undefined> {
    const [patient] = await this.db
      .select()
      .from(patients)
      .where(eq(patients.id, id));
    return patient;
  }

  async findPatientByOpenEMRId(openemrPatientId: string): Promise<Patient | undefined> {
    const [patient] = await this.db
      .select()
      .from(patients)
      .where(eq(patients.openemrPatientId, openemrPatientId));
    return patient;
  }

  async findPatientsByName(searchTerm: string): Promise<Patient[]> {
    const normalizedSearch = `%${searchTerm.toLowerCase()}%`;
    const results = await this.db
      .select()
      .from(patients)
      .where(
        sql`LOWER(${patients.firstName} || ' ' || ${patients.lastName}) LIKE ${normalizedSearch}`
      );
    return results;
  }

  async findDuplicatePatients(firstName: string, lastName: string, dateOfBirth: string): Promise<Patient[]> {
    const fingerprint = createDedupeFingerprint(firstName, lastName, dateOfBirth);
    const duplicates = await this.db
      .select()
      .from(patients)
      .where(eq(patients.dedupeFingerprint, fingerprint));
    return duplicates;
  }

  async updatePatientOpenEMRIds(id: string, patientFhirId: string, patientPid: string): Promise<void> {
    await this.db
      .update(patients)
      .set({
        openemrPatientId: patientFhirId,
        openemrPatientPid: patientPid,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(patients.id, id));
  }

  async getAllPatients(): Promise<Patient[]> {
    const allPatients = await this.db.select().from(patients);
    return allPatients.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async getPatientsForUser(userId: string): Promise<Patient[]> {
    // Get all unique patient IDs that belong to this user (via encounters)
    const userEncounters = await this.db
      .select({ patientId: encounters.patientId })
      .from(encounters)
      .where(eq(encounters.userId, userId));

    // Get unique patient IDs
    const patientIds = Array.from(new Set(userEncounters.map((e: any) => e.patientId)));

    if (patientIds.length === 0) {
      return [];
    }

    // Fetch all patients matching those IDs
    const userPatients = await this.db
      .select()
      .from(patients)
      .where(inArray(patients.id, patientIds));

    return userPatients.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async deleteOrphanedPatients(): Promise<number> {
    // Get all patient IDs that have encounters
    const patientsWithEncounters = await this.db
      .select({ patientId: encounters.patientId })
      .from(encounters);
    
    const patientIdsWithEncounters = new Set(patientsWithEncounters.map((e: any) => e.patientId));
    
    // Get all patients
    const allPatients = await this.db.select().from(patients);
    
    // Find orphaned patients (no encounters)
    const orphanedPatientIds = allPatients
      .filter(p => !patientIdsWithEncounters.has(p.id))
      .map(p => p.id);
    
    if (orphanedPatientIds.length === 0) {
      return 0;
    }
    
    // Delete orphaned patients
    await this.db
      .delete(patients)
      .where(inArray(patients.id, orphanedPatientIds));
    
    return orphanedPatientIds.length;
  }

  // Encounter operations
  private generateReferenceNumber(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `REF-${timestamp}-${random}`;
  }

  async createEncounter(insertEncounter: InsertEncounter, patientId: string, userId: string): Promise<Encounter> {
    const referenceNumber = this.generateReferenceNumber();
    
    const [encounter] = await this.db
      .insert(encounters)
      .values({
        ...insertEncounter,
        referenceNumber,
        patientId,
        userId,
      })
      .returning();
    
    return encounter;
  }

  async getEncounterById(id: string): Promise<Encounter | undefined> {
    const [encounter] = await this.db
      .select()
      .from(encounters)
      .where(eq(encounters.id, id));
    return encounter;
  }

  async getEncounterByReferenceNumber(referenceNumber: string): Promise<Encounter | undefined> {
    const [encounter] = await this.db
      .select()
      .from(encounters)
      .where(eq(encounters.referenceNumber, referenceNumber));
    return encounter;
  }

  async findEncounterByOpenEMRId(openemrEncounterId: string): Promise<Encounter | undefined> {
    const [encounter] = await this.db
      .select()
      .from(encounters)
      .where(eq(encounters.openemrEncounterId, openemrEncounterId));
    return encounter;
  }

  async getEncountersByPatientId(patientId: string): Promise<Encounter[]> {
    const patientEncounters = await this.db
      .select()
      .from(encounters)
      .where(eq(encounters.patientId, patientId));
    return patientEncounters.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }

  async getEncountersByUserId(userId: string): Promise<Encounter[]> {
    const userEncounters = await this.db
      .select()
      .from(encounters)
      .where(eq(encounters.userId, userId));
    return userEncounters.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }

  async getAllEncounters(): Promise<Encounter[]> {
    const allEncounters = await this.db.select().from(encounters);
    return allEncounters.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }

  async updateEncounterOpenEMRIds(id: string, encounterId: string | null): Promise<void> {
    await this.db
      .update(encounters)
      .set({
        openemrEncounterId: encounterId,
      })
      .where(eq(encounters.id, id));
  }

  async updateEncounterPractitionerInfo(id: string, practitioner: string | null, practitionerId: string | null): Promise<void> {
    await this.db
      .update(encounters)
      .set({
        openemrPractitioner: practitioner,
        openemrPractitionerId: practitionerId,
      })
      .where(eq(encounters.id, id));
  }

  async updateEncounterDocumentIds(id: string, documentIds: string[]): Promise<void> {
    await this.db
      .update(encounters)
      .set({
        openemrDocumentIds: documentIds,
      })
      .where(eq(encounters.id, id));
  }

  async updateEncounterSyncStatus(id: string, syncStatus: string, syncError: string | null): Promise<void> {
    await this.db
      .update(encounters)
      .set({
        syncStatus,
        syncError,
        lastSyncedAt: syncStatus === 'synced' ? new Date() : null,
      })
      .where(eq(encounters.id, id));
  }

  async updateEncounterSubmittedAt(id: string, submittedAt: Date): Promise<void> {
    await this.db
      .update(encounters)
      .set({
        submittedAt,
      })
      .where(eq(encounters.id, id));
  }

  async deleteEncounterById(id: string): Promise<void> {
    await this.db
      .delete(encounters)
      .where(eq(encounters.id, id));
  }

  async deleteEncountersByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.db
      .delete(encounters)
      .where(inArray(encounters.id, ids));

    return result.rowCount || 0;
  }

  // Legacy referral operations (backward compatibility - kept for transition period)
  async createReferral(insertReferral: InsertReferral, userId: string): Promise<Referral> {
    const referenceNumber = this.generateReferenceNumber();
    
    const [referral] = await this.db
      .insert(referrals)
      .values({
        ...insertReferral,
        referenceNumber,
        userId,
      })
      .returning();
    
    return referral;
  }

  async getAllReferrals(): Promise<Referral[]> {
    const allReferrals = await this.db.select().from(referrals);
    return allReferrals.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }

  async getReferralsByUserId(userId: string): Promise<Referral[]> {
    const userReferrals = await this.db
      .select()
      .from(referrals)
      .where(eq(referrals.userId, userId));
    return userReferrals.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }

  async getReferralByReferenceNumber(referenceNumber: string): Promise<Referral | undefined> {
    const [referral] = await this.db
      .select()
      .from(referrals)
      .where(eq(referrals.referenceNumber, referenceNumber));
    
    return referral;
  }

  async getReferralById(id: string): Promise<Referral | undefined> {
    const [referral] = await this.db
      .select()
      .from(referrals)
      .where(eq(referrals.id, id));
    
    return referral;
  }

  async updateReferralOpenEMRIds(id: string, patientFhirId: string, patientPid: string, encounterId: string | null): Promise<void> {
    await this.db
      .update(referrals)
      .set({
        openemrPatientId: patientFhirId,
        openemrPatientPid: patientPid,
        openemrEncounterId: encounterId,
      })
      .where(eq(referrals.id, id));
  }

  async updateReferralDocumentIds(id: string, documentIds: string[]): Promise<void> {
    await this.db
      .update(referrals)
      .set({
        openemrDocumentIds: documentIds,
      })
      .where(eq(referrals.id, id));
  }

  async clearReferralOpenEMRIds(id: string): Promise<void> {
    await this.db
      .update(referrals)
      .set({
        openemrPatientId: null,
        openemrPatientPid: null,
        openemrEncounterId: null,
      })
      .where(eq(referrals.id, id));
  }

  async updateReferralSyncStatus(id: string, syncStatus: string, syncError: string | null): Promise<void> {
    await this.db
      .update(referrals)
      .set({
        syncStatus,
        syncError,
        lastSyncedAt: syncStatus === 'synced' ? new Date() : null,
      })
      .where(eq(referrals.id, id));
  }

  // Settings operations
  async getSystemSettings(): Promise<SystemSettings | undefined> {
    const [settings] = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, "singleton"));
    return settings;
  }

  async updateSystemSettings(notificationEmail: string | null): Promise<SystemSettings> {
    const [settings] = await this.db
      .insert(systemSettings)
      .values({
        id: "singleton",
        notificationEmail,
      })
      .onConflictDoUpdate({
        target: systemSettings.id,
        set: {
          notificationEmail,
          updatedAt: new Date(),
        },
      })
      .returning();
    return settings;
  }

  // OpenEMR token persistence
  async getOpenEMRRefreshToken(): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(openemrTokens)
      .where(eq(openemrTokens.id, "singleton"));
    return row?.refreshToken ?? null;
  }

  async saveOpenEMRRefreshToken(refreshToken: string | null): Promise<void> {
    await this.db
      .insert(openemrTokens)
      .values({ id: "singleton", refreshToken })
      .onConflictDoUpdate({
        target: openemrTokens.id,
        set: { refreshToken, updatedAt: new Date() },
      });
  }

  async getOpenEMRClient(): Promise<OpenEMRClient | undefined> {
    const [row] = await this.db
      .select()
      .from(openemrClient)
      .where(eq(openemrClient.id, "singleton"));
    return row;
  }

  async saveOpenEMRClient(client: Omit<OpenEMRClient, "id" | "updatedAt">): Promise<OpenEMRClient> {
    const [row] = await this.db
      .insert(openemrClient)
      .values({ id: "singleton", ...client })
      .onConflictDoUpdate({
        target: openemrClient.id,
        set: { ...client, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async hasAdminUser(): Promise<boolean> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .limit(1);
    return !!row;
  }

  // Referral documents. Lists leave out the content column; files can be 10MB.
  private documentInfoColumns = {
    id: encounterDocuments.id,
    encounterId: encounterDocuments.encounterId,
    userId: encounterDocuments.userId,
    fileName: encounterDocuments.fileName,
    contentType: encounterDocuments.contentType,
    size: encounterDocuments.size,
    openemrSyncStatus: encounterDocuments.openemrSyncStatus,
    openemrSyncError: encounterDocuments.openemrSyncError,
    openemrSyncedAt: encounterDocuments.openemrSyncedAt,
    createdAt: encounterDocuments.createdAt,
  };

  async createDocument(doc: { userId: string; fileName: string; contentType: string; size: number; content: string }): Promise<EncounterDocumentInfo> {
    // Insert without returning the row, so the content isn't sent back
    const id = randomUUID();
    await this.db.insert(encounterDocuments).values({ id, ...doc });
    const [row] = await this.db
      .select(this.documentInfoColumns)
      .from(encounterDocuments)
      .where(eq(encounterDocuments.id, id));
    return row;
  }

  async getDocument(id: string): Promise<EncounterDocument | undefined> {
    const [row] = await this.db
      .select()
      .from(encounterDocuments)
      .where(eq(encounterDocuments.id, id));
    return row;
  }

  async getDocumentsForEncounter(encounterId: string): Promise<EncounterDocumentInfo[]> {
    return await this.db
      .select(this.documentInfoColumns)
      .from(encounterDocuments)
      .where(eq(encounterDocuments.encounterId, encounterId))
      .orderBy(encounterDocuments.createdAt);
  }

  async getUnsyncedDocumentsForEncounter(encounterId: string): Promise<EncounterDocument[]> {
    return await this.db
      .select()
      .from(encounterDocuments)
      .where(and(
        eq(encounterDocuments.encounterId, encounterId),
        ne(encounterDocuments.openemrSyncStatus, "synced"),
      ))
      .orderBy(encounterDocuments.createdAt);
  }

  // Only the uploader's own, not-yet-attached files can be attached
  async attachDocumentsToEncounter(ids: string[], userId: string, encounterId: string): Promise<number> {
    if (ids.length === 0) return 0;
    await this.db
      .update(encounterDocuments)
      .set({ encounterId })
      .where(and(
        inArray(encounterDocuments.id, ids),
        eq(encounterDocuments.userId, userId),
        isNull(encounterDocuments.encounterId),
      ));
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(encounterDocuments)
      .where(eq(encounterDocuments.encounterId, encounterId));
    return count;
  }

  async deleteUnattachedDocument(id: string, userId: string): Promise<boolean> {
    const where = and(
      eq(encounterDocuments.id, id),
      eq(encounterDocuments.userId, userId),
      isNull(encounterDocuments.encounterId),
    );
    const [found] = await this.db.select({ id: encounterDocuments.id }).from(encounterDocuments).where(where);
    if (!found) return false;
    await this.db.delete(encounterDocuments).where(where);
    return true;
  }

  async updateDocumentSync(id: string, status: "synced" | "failed", error: string | null): Promise<void> {
    await this.db
      .update(encounterDocuments)
      .set({
        openemrSyncStatus: status,
        openemrSyncError: error,
        openemrSyncedAt: status === "synced" ? new Date() : null,
      })
      .where(eq(encounterDocuments.id, id));
  }

  // Uploads from forms that were never submitted
  async deleteStaleUnattachedDocuments(olderThan: Date): Promise<void> {
    await this.db
      .delete(encounterDocuments)
      .where(and(isNull(encounterDocuments.encounterId), lt(encounterDocuments.createdAt, olderThan)));
  }

  // Single atomic statement, so concurrent callers never get the same value
  async nextCounterValue(name: string): Promise<number> {
    const [row] = await this.db
      .insert(counters)
      .values({ name, value: 1 })
      .onConflictDoUpdate({
        target: counters.name,
        set: { value: sql`${counters.value} + 1` },
      })
      .returning();
    return row.value;
  }
}

// Export singleton instance
export const storage = new DbStorage();
