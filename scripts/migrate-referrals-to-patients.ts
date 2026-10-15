/**
 * Migration Script: Convert Referrals to Patients + Encounters
 * 
 * This script migrates existing referrals into the new patient-centric architecture:
 * 1. Extracts unique patients from referrals (deduplicated by name + DOB)
 * 2. Creates patient records in the patients table
 * 3. Creates encounter records in the encounters table linked to patients
 * 
 * Run with: tsx scripts/migrate-referrals-to-patients.ts
 */

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { referrals, patients, encounters } from "../shared/schema";
import { eq } from "drizzle-orm";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

// Create deduplication fingerprint (normalized name + DOB)
function createDedupeFingerprint(firstName: string, lastName: string, dateOfBirth: string): string {
  const normalizedFirst = firstName.toLowerCase().trim();
  const normalizedLast = lastName.toLowerCase().trim();
  const normalizedDOB = dateOfBirth.trim();
  return `${normalizedFirst}|${normalizedLast}|${normalizedDOB}`;
}

async function migrateReferralsToPatients() {
  console.log("🔄 Starting migration of referrals to patients + encounters...\n");
  
  // 1. Fetch all existing referrals
  const allReferrals = await db.select().from(referrals);
  console.log(`📊 Found ${allReferrals.length} referrals to migrate\n`);
  
  if (allReferrals.length === 0) {
    console.log("✅ No referrals to migrate. Exiting.");
    return;
  }
  
  // 2. Group referrals by unique patient (deduplicate by name + DOB)
  const patientMap = new Map<string, typeof allReferrals>();
  
  for (const referral of allReferrals) {
    const fingerprint = createDedupeFingerprint(
      referral.firstName,
      referral.lastName,
      referral.dateOfBirth
    );
    
    if (!patientMap.has(fingerprint)) {
      patientMap.set(fingerprint, []);
    }
    patientMap.get(fingerprint)!.push(referral);
  }
  
  console.log(`👥 Identified ${patientMap.size} unique patients\n`);
  
  // 3. Create patient records and their encounters
  const createdPatients = [];
  const createdEncounters = [];
  
  for (const [fingerprint, referralGroup] of patientMap.entries()) {
    // Use the first referral in the group to create the patient
    const firstReferral = referralGroup[0];
    
    console.log(`Creating patient: ${firstReferral.firstName} ${firstReferral.lastName} (${fingerprint})`);
    
    // Create patient record
    const [patient] = await db.insert(patients).values({
      firstName: firstReferral.firstName,
      lastName: firstReferral.lastName,
      dateOfBirth: firstReferral.dateOfBirth,
      gender: firstReferral.gender,
      email: firstReferral.email,
      phone: firstReferral.phone,
      primaryLanguage: firstReferral.primaryLanguage || null,
      insurancePlan: firstReferral.insurancePlan || null,
      policyNumber: firstReferral.policyNumber || null,
      groupNumber: firstReferral.groupNumber || null,
      effectiveDate: firstReferral.effectiveDate || null,
      openemrPatientId: firstReferral.openemrPatientId || null,
      openemrPatientPid: firstReferral.openemrPatientPid || null,
      lastSyncedAt: firstReferral.lastSyncedAt || null,
      dedupeFingerprint: fingerprint,
    }).returning();
    
    createdPatients.push(patient);
    console.log(`  ✓ Created patient ID: ${patient.id}`);
    
    // Create encounter for each referral in this group
    for (const referral of referralGroup) {
      const [encounter] = await db.insert(encounters).values({
        referenceNumber: referral.referenceNumber,
        patientId: patient.id,
        userId: referral.userId,
        diagnosis: referral.diagnosis,
        urgency: referral.urgency,
        medicalHistory: referral.medicalHistory || null,
        currentMedications: referral.currentMedications || null,
        icd10Code: referral.icd10Code || null,
        referralReason: referral.referralReason || null,
        referringProvider: referral.referringProvider,
        providerContact: referral.providerContact,
        status: referral.status,
        openemrEncounterId: referral.openemrEncounterId || null,
        openemrDocumentIds: referral.openemrDocumentIds || [],
        syncStatus: referral.syncStatus,
        lastSyncedAt: referral.lastSyncedAt || null,
        syncError: referral.syncError || null,
        submittedAt: referral.submittedAt,
      }).returning();
      
      createdEncounters.push(encounter);
      console.log(`  ✓ Created encounter ${referral.referenceNumber} for this patient`);
    }
    
    console.log();
  }
  
  console.log("\n📋 Migration Summary:");
  console.log(`  • Patients created: ${createdPatients.length}`);
  console.log(`  • Encounters created: ${createdEncounters.length}`);
  console.log(`  • Original referrals: ${allReferrals.length}`);
  
  // Verify data integrity
  const duplicateCheck = createdPatients.length + createdEncounters.length;
  if (createdEncounters.length === allReferrals.length) {
    console.log("\n✅ Migration completed successfully!");
    console.log("\n⚠️  NOTE: Original referrals table is still intact for rollback purposes.");
    console.log("   Once you've verified the migration, you can optionally drop the referrals table.");
  } else {
    console.error("\n❌ Migration count mismatch! Please review manually.");
  }
}

// Run migration
migrateReferralsToPatients()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  });
