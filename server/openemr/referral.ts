import { openEMRRequest, type OpenEMRError } from "./client";
import { getPatient, getPatientIds, createPatient, updatePatient, searchPatients, addPatientInsurance, setPatientReferringProvider, applyDemographicsDefaults } from "./patient";
import { findOrCreatePractitionerFromRegistry } from "./practitioner";
import { addMedicalProblems, addMedications } from "./clinical";
import { resolveSubscriberSsn } from "./ssn";
import type { Patient, Encounter } from "@shared/schema";

// FHIR Encounter resource (simplified)
interface FHIREncounter {
  resourceType: "Encounter";
  id?: string;
  status: "planned" | "arrived" | "in-progress" | "finished" | "cancelled";
  class: {
    system: string;
    code: string;
    display: string;
  };
  type?: Array<{
    coding?: Array<{
      system?: string;
      code?: string;
      display?: string;
    }>;
    text?: string;
  }>;
  subject: {
    reference: string;
  };
  reasonCode?: Array<{
    coding?: Array<{
      system?: string;
      code?: string;
      display?: string;
    }>;
    text?: string;
  }>;
  diagnosis?: Array<{
    condition: {
      display?: string;
    };
    use?: {
      coding?: Array<{
        system?: string;
        code?: string;
      }>;
    };
  }>;
  period?: {
    start?: string;
  };
  participant?: Array<{
    type?: Array<{
      coding?: Array<{
        system?: string;
        code?: string;
        display?: string;
      }>;
      text?: string;
    }>;
    individual?: {
      reference?: string;
      display?: string;
    };
  }>;
  priority?: {
    coding?: Array<{
      system?: string;
      code?: string;
      display?: string;
    }>;
    text?: string;
  };
  extension?: Array<{
    url: string;
    valueString?: string;
  }>;
}

export interface SyncResult {
  success: boolean;
  partial: boolean;
  patientFhirId: string;
  patientPid: string;
  encounterId?: string;
  error?: string;
  updatedPatient?: boolean; // Indicates if patient OpenEMR IDs were newly created/updated
  warnings?: string[]; // Encounter created, but some details didn't reach OpenEMR
}

export interface PushOptions {
  // OpenEMR Address Book id of the referring provider (users.openemrProviderId)
  referringProviderId?: string | null;
}

/**
 * Push a patient and encounter to OpenEMR
 * Patient-centric: one patient can have multiple encounters
 */
export async function pushEncounterToOpenEMR(
  patient: Patient,
  encounter: Encounter,
  options: PushOptions = {}
): Promise<SyncResult> {
  const address = {
    street: patient.street || undefined,
    city: patient.city || undefined,
    state: patient.state || undefined,
    postalCode: patient.postalCode || undefined,
  };

  // Step 1: Find or create patient in OpenEMR
  let patientFhirId = patient.openemrPatientId;
  let patientPid = patient.openemrPatientPid;
  let patientAlreadyExists = false;
  let updatedPatient = false;

  if (!patientFhirId || !patientPid) {
    // Search for existing patient
    const existingPatients = await searchPatients(
      patient.firstName,
      patient.lastName,
      patient.dateOfBirth
    );

    if (existingPatients.length > 0) {
      // Use existing patient - get PID without creating a duplicate
      const existingFhirId = existingPatients[0].id;
      console.log(`[OpenEMR] Found existing patient with FHIR ID: ${existingFhirId}, fetching PID...`);
      
      const patientIds = await getPatientIds(existingFhirId);
      
      if (patientIds) {
        // Successfully got both IDs from existing patient
        patientFhirId = patientIds.fhirId;
        patientPid = patientIds.pid;
        patientAlreadyExists = true;
        updatedPatient = true; // Need to store these IDs
        console.log(`[OpenEMR] Using existing patient - FHIR ID: ${patientFhirId}, PID: ${patientPid}`);
      } else {
        // Could not get PID, create a new patient as fallback
        console.log(`[OpenEMR] Could not get PID for existing patient, creating new patient`);
        const newPatientIds = await createPatient({
          firstName: patient.firstName,
          lastName: patient.lastName,
          dateOfBirth: patient.dateOfBirth,
          gender: patient.gender,
          email: patient.email,
          phone: patient.phone,
          primaryLanguage: patient.primaryLanguage || undefined,
          ...address,
        });
        patientFhirId = newPatientIds.fhirId;
        patientPid = newPatientIds.pid;
        updatedPatient = true; // Need to store these IDs
      }
    } else {
      // Create new patient (throws on error)
      const patientIds = await createPatient({
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        email: patient.email,
        phone: patient.phone,
        primaryLanguage: patient.primaryLanguage || undefined,
        ...address,
      });
      patientFhirId = patientIds.fhirId;
      patientPid = patientIds.pid;
      updatedPatient = true; // Need to store these IDs
    }
  } else {
    // Patient IDs were already stored from a previous sync
    patientAlreadyExists = true;
    console.log(`[OpenEMR] Using stored patient IDs - FHIR ID: ${patientFhirId}, PID: ${patientPid}`);
  }

  // Keep language/address current on patients that already existed in OpenEMR
  if (patientAlreadyExists && patientFhirId) {
    const hasAddress = address.street || address.city || address.state || address.postalCode;
    if (patient.primaryLanguage || hasAddress) {
      // Throws on 4xx; 5xx only logs a warning
      await updatePatient(patientFhirId, {
        primaryLanguage: patient.primaryLanguage || undefined,
        ...address,
      });
    }
  }

  const ids = { uuid: patientFhirId!, pid: patientPid! };
  const encounterDate = encounter.submittedAt.toISOString().split('T')[0];
  const warnings: string[] = [];

  // Step 2: Create the encounter via REST. OpenEMR's FHIR Encounter is
  // read-only, so a FHIR POST always fails.
  const urgencyLabel: Record<string, string> = {
    emergency: "Emergency",
    urgent: "Urgent",
    routine: "Routine",
  };

  // This is the "Reason for Visit" on the encounter form
  const reasonLines: string[] = [];
  if (encounter.referralReason?.trim()) reasonLines.push(`Referral reason: ${encounter.referralReason.trim()}`);
  if (encounter.diagnosis?.trim()) {
    reasonLines.push(`Diagnosis: ${encounter.diagnosis.trim()}${encounter.icd10Code ? ` (ICD-10 ${encounter.icd10Code})` : ""}`);
  }
  reasonLines.push(`Urgency: ${urgencyLabel[encounter.urgency] || encounter.urgency}`);
  const referrer = [encounter.referringProvider?.trim(), encounter.providerContact?.trim()].filter(Boolean);
  if (referrer.length > 0) {
    reasonLines.push(`Referred by: ${referrer[0]}${referrer[1] ? ` (${referrer[1]})` : ""}`);
  }
  reasonLines.push(`Referral #${encounter.referenceNumber}`);

  const restEncounterPayload: Record<string, string> = {
    date: encounterDate,
    onset_date: encounterDate,
    reason: reasonLines.join("\n"),
    pc_catid: process.env.OPENEMR_ENCOUNTER_CATEGORY_ID || "5",
    facility_id: process.env.OPENEMR_FACILITY_ID || "3",
    billing_facility: process.env.OPENEMR_FACILITY_ID || "3",
    sensitivity: "normal",
    provider_id: process.env.OPENEMR_PROVIDER_ID || "1",
    class_code: "AMB",
  };
  // An NPI typed on the referral wins over the submitter's own account link
  let referringProviderId = options.referringProviderId || null;
  if (encounter.referringProviderNpi) {
    try {
      const link = await findOrCreatePractitionerFromRegistry(
        encounter.referringProviderNpi,
        encounter.providerContact
      );
      referringProviderId = link.id;
      console.log(`[OpenEMR] Referring provider ${link.created ? "created" : "found"} for NPI ${encounter.referringProviderNpi}: id ${link.id}`);
    } catch (error: any) {
      console.warn(`[OpenEMR] Referring provider lookup failed for NPI ${encounter.referringProviderNpi}:`, error?.message || error);
      warnings.push(`Referring provider NPI ${encounter.referringProviderNpi} could not be added to the OpenEMR Address Book: ${error?.message || error}`);
    }
  }
  if (referringProviderId) {
    restEncounterPayload.referring_provider_id = referringProviderId;
  }

  console.log("[OpenEMR] Creating encounter:", JSON.stringify(restEncounterPayload, null, 2));
  console.log("[OpenEMR] Using patient FHIR ID:", patientFhirId, "PID:", patientPid);

  let encounterId: string | undefined;
  try {
    const restResult = await openEMRRequest<any>(`/apis/default/api/patient/${patientFhirId}/encounter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(restEncounterPayload),
    });

    console.log("[OpenEMR] REST encounter creation response:", JSON.stringify(restResult, null, 2));

    const validation = restResult?.validationErrors;
    if (validation && (Array.isArray(validation) ? validation.length > 0 : Object.keys(validation).length > 0)) {
      throw {
        status: 400,
        message: `OpenEMR rejected the encounter: ${JSON.stringify(validation)}`,
        retryable: false,
      };
    }

    // Prefer the UUID: it matches the FHIR Encounter id that pull/reconcile compare against
    const data = restResult?.data ?? restResult;
    const found = data?.uuid ?? data?.encounter ?? data?.eid ?? data?.id;
    if (found) {
      encounterId = String(found);
    } else if (Array.isArray(restResult?.internalErrors) && restResult.internalErrors.length === 0) {
      console.log("[OpenEMR] Encounter created successfully (no ID returned but no errors)");
      encounterId = `created-${Date.now()}`;
    }
  } catch (encounterError: any) {
    if (encounterError?.status === 404) {
      console.log("[OpenEMR] Encounter endpoint not available (404), treating as partial sync");
      return {
        success: false,
        partial: true,
        patientFhirId,
        patientPid,
        error: "Patient synced successfully to OpenEMR. However, encounter creation is not available - this may require additional OpenEMR configuration or permissions. You can manually create the encounter in OpenEMR if needed."
      };
    }
    throw encounterError;
  }

  if (!encounterId) {
    console.error("[OpenEMR] Missing encounter ID in response");
    return {
      success: false,
      partial: true,
      patientFhirId,
      patientPid,
      error: "Patient synced successfully to OpenEMR. Encounter creation returned no ID - this may indicate an OpenEMR configuration issue. You can manually create the encounter in OpenEMR if needed."
    };
  }

  console.log("[OpenEMR] Successfully created encounter with ID:", encounterId);

  const choicesError = await applyDemographicsDefaults(patientFhirId!, {
    gender: patient.gender,
    phone: patient.phone,
    newPatient: !patientAlreadyExists,
  });
  if (choicesError) warnings.push(choicesError);

  // The most recent referral sets the patient's Referring Provider in Demographics
  if (referringProviderId) {
    const refError = await setPatientReferringProvider(patientFhirId!, referringProviderId);
    if (refError) warnings.push(refError);
  }

  // Step 3: Medical history -> Medical Problems list, medications -> Medications list
  const problems = await addMedicalProblems(ids, encounter.medicalHistory, encounterDate);
  if (problems.error) warnings.push(problems.error);
  const meds = await addMedications(ids, encounter.currentMedications, encounterDate);
  if (meds.error) warnings.push(meds.error);

  // Step 4: Insurance -> patient's Insurance tab. The referral form collects it
  // on the encounter; fall back to what's stored on the patient.
  const onEncounter = !!(encounter.insurancePlan || encounter.policyNumber);
  const insuranceSource = onEncounter ? encounter : patient;
  if (insuranceSource.insurancePlan || insuranceSource.policyNumber) {
    const relationship = (onEncounter && encounter.subscriberRelationship) || "self";
    const holder = relationship === "self"
      ? { firstName: patient.firstName, lastName: patient.lastName, dob: patient.dateOfBirth, sex: patient.gender }
      : {
          firstName: encounter.subscriberFirstName || "",
          lastName: encounter.subscriberLastName || "",
          dob: encounter.subscriberDob || "",
          sex: encounter.subscriberSex || "",
        };
    // Subscriber address: what the referral gave, else the patient's
    const subscriberAddress = onEncounter && encounter.subscriberStreet
      ? {
          street: encounter.subscriberStreet,
          city: encounter.subscriberCity || undefined,
          state: encounter.subscriberState || undefined,
          postalCode: encounter.subscriberPostalCode || undefined,
        }
      : address;

    const ssn = await resolveSubscriberSsn(
      patientFhirId!,
      relationship,
      onEncounter ? encounter.subscriberSsn : null
    );
    if (ssn.warning) warnings.push(ssn.warning);

    const insurance = await addPatientInsurance(ids, {
      insurancePlan: insuranceSource.insurancePlan || undefined,
      policyNumber: insuranceSource.policyNumber || undefined,
      groupNumber: insuranceSource.groupNumber || undefined,
      effectiveDate: insuranceSource.effectiveDate || undefined,
      endDate: (onEncounter && encounter.insuranceEndDate) || undefined,
      subscriberRelationship: relationship,
      subscriberFirstName: holder.firstName,
      subscriberLastName: holder.lastName,
      subscriberDOB: holder.dob,
      subscriberSex: holder.sex,
      subscriberPhone: patient.phone || undefined,
      subscriberSsn: ssn.ssn,
      acceptAssignment: onEncounter ? encounter.acceptAssignment !== false : true,
      ...subscriberAddress,
    });
    if (!insurance.ok && insurance.message) warnings.push(insurance.message);
  }

  if (warnings.length > 0) {
    console.warn("[OpenEMR] Encounter synced with warnings:", warnings);
  }

  return {
    success: true,
    partial: warnings.length > 0,
    patientFhirId,
    patientPid,
    encounterId,
    updatedPatient,
    warnings,
    error: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

/**
 * Backward compatibility wrapper for legacy referral endpoints
 * Converts a referral to patient/encounter and calls the new sync function
 */
export async function pushReferralToOpenEMR(referral: any): Promise<SyncResult> {
  // Extract patient data from referral
  const patient = {
    id: referral.id, // Use referral ID as patient ID for legacy compatibility
    firstName: referral.firstName,
    lastName: referral.lastName,
    dateOfBirth: referral.dateOfBirth,
    gender: referral.gender,
    email: referral.email,
    phone: referral.phone,
    primaryLanguage: referral.primaryLanguage,
    insurancePlan: referral.insurancePlan,
    policyNumber: referral.policyNumber,
    groupNumber: referral.groupNumber,
    effectiveDate: referral.effectiveDate,
    openemrPatientId: referral.openemrPatientId,
    openemrPatientPid: referral.openemrPatientPid,
  };

  // Extract encounter data from referral
  const encounter = {
    id: referral.id,
    referenceNumber: referral.referenceNumber,
    patientId: referral.id,
    userId: referral.userId,
    diagnosis: referral.diagnosis,
    urgency: referral.urgency,
    medicalHistory: referral.medicalHistory,
    currentMedications: referral.currentMedications,
    icd10Code: referral.icd10Code,
    referralReason: referral.referralReason,
    insurancePlan: referral.insurancePlan,
    policyNumber: referral.policyNumber,
    groupNumber: referral.groupNumber,
    effectiveDate: referral.effectiveDate,
    referringProvider: referral.referringProvider,
    providerContact: referral.providerContact,
    status: referral.status,
    openemrEncounterId: referral.openemrEncounterId,
    openemrDocumentIds: referral.openemrDocumentIds,
    syncStatus: referral.syncStatus,
    lastSyncedAt: referral.lastSyncedAt,
    syncError: referral.syncError,
    submittedAt: referral.submittedAt,
  };

  // Call the new patient-centric sync function
  return pushEncounterToOpenEMR(patient as any, encounter as any);
}

/**
 * Update referral status in OpenEMR
 */
export async function updateReferralStatusInOpenEMR(
  encounterId: string,
  status: string
): Promise<boolean> {
  try {
    const encounter: Partial<FHIREncounter> = {
      resourceType: "Encounter",
      status: mapStatusToOpenEMR(status),
    };

    const endpoint = `/apis/default/fhir/Encounter/${encounterId}`;
    
    await openEMRRequest<FHIREncounter>(endpoint, {
      method: "PUT",
      headers: {
        "Content-Type": "application/fhir+json",
      },
      body: JSON.stringify(encounter),
    });

    return true;
  } catch (error) {
    const err = error as OpenEMRError;
    console.error("Error updating encounter status in OpenEMR:", err.message, "Retryable:", err.retryable);
    return false;
  }
}

/**
 * Pull encounters from OpenEMR and return structured data
 * Fetches both encounter and patient details from REST API for more complete data
 */
export async function pullEncountersFromOpenEMR(
  sinceDate?: Date
): Promise<Array<{
  encounter: {
    openemrEncounterId: string;
    diagnosis: string;
    urgency: 'routine' | 'urgent' | 'emergency';
    medicalHistory?: string;
    currentMedications?: string;
    icd10Code?: string;
    referralReason?: string;
    referringProvider?: string;
    providerContact?: string;
    openemrPractitioner?: string;
    openemrPractitionerId?: string;
    submittedAt: Date;
  };
  patient: {
    openemrPatientId: string;
    openemrPatientPid?: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    gender: string;
    email?: string;
    phone?: string;
    primaryLanguage?: string;
    insurancePlan?: string;
    policyNumber?: string;
    groupNumber?: string;
    effectiveDate?: string;
  };
}>> {
  try {
    // Fetch encounters from OpenEMR FHIR API
    const params = new URLSearchParams({
      _sort: "-date",
      _count: "50",
    });

    if (sinceDate) {
      params.append("date", `ge${sinceDate.toISOString().split('T')[0]}`);
    }

    const endpoint = `/apis/default/fhir/Encounter?${params.toString()}`;
    console.log(`[OpenEMR Pull] Fetching encounters from ${endpoint}`);
    
    const response = await openEMRRequest<{
      resourceType: "Bundle";
      entry?: Array<{ resource: FHIREncounter }>;
    }>(endpoint);

    if (!response || !response.entry || response.entry.length === 0) {
      console.log("[OpenEMR Pull] No encounters found");
      return [];
    }

    console.log(`[OpenEMR Pull] Found ${response.entry.length} encounters`);

    // Process each encounter and fetch patient details
    const results = [];
    for (const entry of response.entry) {
      try {
        const fhirEncounter = entry.resource;
        
        if (!fhirEncounter.id || !fhirEncounter.subject?.reference) {
          console.log("[OpenEMR Pull] Skipping encounter without ID or patient reference");
          continue;
        }

        // Extract patient FHIR ID from reference
        const patientFhirId = fhirEncounter.subject.reference.replace("Patient/", "");
        
        // Fetch patient details from OpenEMR
        console.log(`[OpenEMR Pull] Fetching patient ${patientFhirId}`);
        const patientData = await getPatient(patientFhirId);
        
        if (!patientData) {
          console.log(`[OpenEMR Pull] Could not fetch patient ${patientFhirId}, skipping encounter`);
          continue;
        }

        // Extract diagnosis from reasonCode or type
        let diagnosis = fhirEncounter.reasonCode?.[0]?.text || 
                       fhirEncounter.reasonCode?.[0]?.coding?.[0]?.display;
        
        // If no reasonCode, use the encounter type as diagnosis
        if (!diagnosis || diagnosis === "Please indicate visit reason") {
          diagnosis = fhirEncounter.type?.[0]?.coding?.[0]?.display || "General Consultation";
        }
        
        // Ensure diagnosis is never empty
        const finalDiagnosis = diagnosis || "General Consultation";
        
        // Extract encounter class/type (ambulatory, inpatient, virtual, etc.)
        const encounterType = fhirEncounter.class?.display || fhirEncounter.class?.code;

        // Extract ICD-10 code if present
        const icd10Coding = fhirEncounter.reasonCode?.find(rc => 
          rc.coding?.some(c => c.system === "http://hl7.org/fhir/sid/icd-10")
        );
        const icd10Code = icd10Coding?.coding?.[0]?.code;

        // Map priority to urgency
        let urgency: 'routine' | 'urgent' | 'emergency' = 'routine';
        if (fhirEncounter.priority?.coding?.[0]?.code) {
          const priorityCode = fhirEncounter.priority.coding[0].code;
          if (priorityCode === 'EM' || priorityCode === 'emergency') {
            urgency = 'emergency';
          } else if (priorityCode === 'UR' || priorityCode === 'urgent') {
            urgency = 'urgent';
          }
        }

        // Extract medical history and medications from extensions
        const medicalHistory = fhirEncounter.extension?.find(
          ext => ext.url === "https://referralsystem.local/fhir/StructureDefinition/medical-history"
        )?.valueString;

        const currentMedications = fhirEncounter.extension?.find(
          ext => ext.url === "https://referralsystem.local/fhir/StructureDefinition/current-medications"
        )?.valueString;

        // Extract referring provider and practitioner info
        const referringProviderParticipant = fhirEncounter.participant?.find(
          p => p.type?.some(t => t.coding?.some(c => c.code === "REF" || c.code === "PPRF"))
        );
        const referringProvider = referringProviderParticipant?.individual?.display;
        
        // Extract practitioner ID from reference (format: "Practitioner/123")
        const practitionerReference = referringProviderParticipant?.individual?.reference;
        const openemrPractitionerId = practitionerReference?.replace(/^Practitioner\//, "");
        const openemrPractitioner = referringProvider;

        // Parse patient data
        const [firstName, ...lastNameParts] = (patientData.name?.[0]?.text || "Unknown Patient").split(" ");
        const lastName = lastNameParts.join(" ") || "Unknown";

        results.push({
          encounter: {
            openemrEncounterId: fhirEncounter.id,
            diagnosis: finalDiagnosis,
            encounterType,
            urgency,
            medicalHistory,
            currentMedications,
            icd10Code,
            referralReason: fhirEncounter.reasonCode?.[1]?.text, // Second reasonCode might be referral reason
            referringProvider: referringProvider || "",
            providerContact: "", // Not available in FHIR encounter
            openemrPractitioner,
            openemrPractitionerId,
            submittedAt: fhirEncounter.period?.start ? new Date(fhirEncounter.period.start) : new Date(),
          },
          patient: {
            openemrPatientId: patientFhirId,
            openemrPatientPid: patientData.pid,
            firstName,
            lastName,
            dateOfBirth: patientData.birthDate || "",
            gender: patientData.gender || "unknown",
            email: patientData.telecom?.find(t => t.system === "email")?.value,
            phone: patientData.telecom?.find(t => t.system === "phone")?.value,
            primaryLanguage: patientData.communication?.[0]?.language?.coding?.[0]?.code,
            insurancePlan: patientData.insurancePlan,
            policyNumber: patientData.policyNumber,
            groupNumber: patientData.groupNumber,
            effectiveDate: patientData.effectiveDate,
          },
        });
      } catch (error) {
        console.error("[OpenEMR Pull] Error processing encounter:", error);
        continue;
      }
    }

    console.log(`[OpenEMR Pull] Successfully processed ${results.length} encounters`);
    return results;
  } catch (error) {
    const err = error as OpenEMRError;
    console.error("[OpenEMR Pull] Error fetching encounters:", err.message);
    throw err;
  }
}

/**
 * Map our status to OpenEMR encounter status
 */
function mapStatusToOpenEMR(
  status: string
): "planned" | "arrived" | "in-progress" | "finished" | "cancelled" {
  switch (status.toLowerCase()) {
    case "submitted":
      return "planned";
    case "under review":
      return "arrived";
    case "approved":
      return "in-progress";
    case "scheduled":
      return "finished";
    default:
      return "planned";
  }
}

/**
 * Map OpenEMR encounter status to our status
 */
function mapStatusFromOpenEMR(
  status: "planned" | "arrived" | "in-progress" | "finished" | "cancelled"
): string {
  switch (status) {
    case "planned":
      return "submitted";
    case "arrived":
      return "under review";
    case "in-progress":
      return "approved";
    case "finished":
      return "scheduled";
    case "cancelled":
      return "cancelled";
    default:
      return "submitted";
  }
}

/**
 * Reconcile local encounters with OpenEMR
 * Deletes local encounters that don't exist in OpenEMR (both unsynced and deleted)
 * Returns count of deleted encounters and list of OpenEMR encounter IDs
 * 
 * IMPORTANT: Fetches ALL encounters from OpenEMR following FHIR pagination
 */
export async function reconcileEncountersWithOpenEMR(): Promise<{
  deletedCount: number;
  openemrEncounterIds: string[];
  errors: string[];
}> {
  const errors: string[] = [];

  try {
    console.log("[OpenEMR Reconcile] Starting encounter reconciliation...");

    // Build set of ALL OpenEMR encounter IDs (following pagination)
    const openemrEncounterIds = new Set<string>();
    let nextUrl: string | null = `/apis/default/fhir/Encounter?_sort=-date&_count=1000`;
    let pageCount = 0;
    const maxPages = 100; // Safety limit to prevent infinite loops

    // Follow FHIR pagination to get ALL encounters
    while (nextUrl && pageCount < maxPages) {
      pageCount++;
      console.log(`[OpenEMR Reconcile] Fetching page ${pageCount}...`);
      
      let response;
      try {
        response = await openEMRRequest<{
          resourceType: "Bundle";
          entry?: Array<{ resource: FHIREncounter }>;
          link?: Array<{ relation: string; url: string }>;
        }>(nextUrl);
      } catch (paginationError) {
        const err = paginationError as OpenEMRError;
        console.error(`[OpenEMR Reconcile] Error fetching page ${pageCount}:`, err.message);
        errors.push(`Pagination failed on page ${pageCount}: ${err.message}. Aborting to prevent incomplete reconciliation.`);
        // Abort reconciliation - don't delete anything if we can't fetch all encounters
        return {
          deletedCount: 0,
          openemrEncounterIds: [],
          errors,
        };
      }

      // Extract encounter IDs from this page
      const entriesFound = response?.entry?.length || 0;
      if (response && response.entry) {
        response.entry.forEach(entry => {
          if (entry.resource && entry.resource.id) {
            openemrEncounterIds.add(entry.resource.id);
          }
        });
        console.log(`[OpenEMR Reconcile] Page ${pageCount}: Found ${entriesFound} encounters (total: ${openemrEncounterIds.size})`);
      }

      // Check for next page link
      const hadNextLink = response?.link?.some(link => link.relation === "next");
      nextUrl = null;
      if (response && response.link) {
        const nextLink = response.link.find(link => link.relation === "next");
        if (nextLink && nextLink.url) {
          // FHIR servers should return absolute URLs or complete relative paths with all parameters
          // We trust the server to include all necessary parameters (_count, _sort, etc.)
          let rawUrl = nextLink.url;
          
          // Extract the path and query from the URL
          try {
            // Try parsing as absolute URL
            const parsed = new URL(rawUrl);
            nextUrl = parsed.pathname + parsed.search;
          } catch {
            // Not an absolute URL - handle relative paths
            if (rawUrl.startsWith('/apis/')) {
              // Already a complete API path
              nextUrl = rawUrl;
            } else if (rawUrl.startsWith('/')) {
              // Relative path
              nextUrl = rawUrl;
            } else {
              // Assume it's a partial path and log a warning
              // This should not happen with compliant FHIR servers
              console.warn(`[OpenEMR Reconcile] Unexpected pagination URL format: ${rawUrl}`);
              nextUrl = rawUrl.startsWith('?') 
                ? `/apis/default/fhir/Encounter${rawUrl}` 
                : `/apis/default/fhir/Encounter?${rawUrl}`;
            }
          }
          
          console.log(`[OpenEMR Reconcile] Following pagination link: ${nextUrl}`);
        }
      }

      // Safety check: if we expected more pages but got empty results, abort
      if (hadNextLink && entriesFound === 0) {
        console.error(`[OpenEMR Reconcile] Page ${pageCount} returned 0 entries but had a next link. Possible pagination failure.`);
        errors.push(`Pagination appears incomplete (page ${pageCount} empty). Aborting to prevent data loss.`);
        return {
          deletedCount: 0,
          openemrEncounterIds: [],
          errors,
        };
      }
    }

    if (pageCount >= maxPages) {
      errors.push(`Warning: Reached maximum page limit (${maxPages}). Some encounters may not have been fetched.`);
      console.warn(`[OpenEMR Reconcile] Reached max page limit of ${maxPages}`);
    }

    console.log(`[OpenEMR Reconcile] Completed fetching all encounters. Total: ${openemrEncounterIds.size} encounters across ${pageCount} page(s)`);

    return {
      deletedCount: 0, // Will be filled in by the route handler
      openemrEncounterIds: Array.from(openemrEncounterIds),
      errors,
    };
  } catch (error) {
    const err = error as OpenEMRError;
    console.error("[OpenEMR Reconcile] Error during reconciliation:", err.message);
    errors.push(`Failed to fetch encounters from OpenEMR: ${err.message}`);
    return {
      deletedCount: 0,
      openemrEncounterIds: [],
      errors,
    };
  }
}
