import { openEMRRequest, type OpenEMRError } from "./client";

// FHIR Patient resource (simplified)
export interface FHIRPatient {
  resourceType: "Patient";
  id: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
  };
  identifier?: Array<{
    system?: string;
    value?: string;
    type?: {
      coding?: Array<{
        system?: string;
        code?: string;
      }>;
    };
  }>;
  name?: Array<{
    use?: string;
    family?: string;
    given?: string[];
  }>;
  gender?: string;
  birthDate?: string;
  telecom?: Array<{
    system?: string;
    value?: string;
    use?: string;
  }>;
  address?: Array<{
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
  }>;
  communication?: Array<{
    language?: {
      coding?: Array<{
        system?: string;
        code?: string;
        display?: string;
      }>;
      text?: string;
    };
    preferred?: boolean;
  }>;
  extension?: Array<{
    url: string;
    valueString?: string;
    valueDate?: string;
  }>;
}

// Extended patient data for our system
export interface OpenEMRPatient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
  email?: string;
  phone?: string;
  primaryLanguage?: string;
  insurancePlan?: string;
  policyNumber?: string;
  groupNumber?: string;
  effectiveDate?: string;
}

/**
 * Search for patients in OpenEMR by name
 * Throws OpenEMRError on failure
 */
export async function searchPatients(
  firstName?: string,
  lastName?: string,
  dateOfBirth?: string
): Promise<OpenEMRPatient[]> {
  const params = new URLSearchParams();
  
  if (firstName) params.append("given", firstName);
  if (lastName) params.append("family", lastName);
  if (dateOfBirth) params.append("birthdate", dateOfBirth);

  const endpoint = `/apis/default/fhir/Patient?${params.toString()}`;
  
  const response = await openEMRRequest<{
    resourceType: "Bundle";
    entry?: Array<{ resource: FHIRPatient }>;
  }>(endpoint);

  if (!response || !response.entry) {
    return [];
  }

  const patients = response.entry.map(({ resource }) => {
    const patient = convertFHIRPatient(resource);
    console.log(`[OpenEMR] Patient search result:`, {
      id: patient.id,
      name: `${patient.firstName} ${patient.lastName}`,
      hasInsurance: {
        plan: !!patient.insurancePlan,
        policy: !!patient.policyNumber,
        group: !!patient.groupNumber,
        effectiveDate: !!patient.effectiveDate
      },
      insuranceData: {
        plan: patient.insurancePlan,
        policy: patient.policyNumber,
        group: patient.groupNumber,
        effectiveDate: patient.effectiveDate
      }
    });
    return patient;
  });
  
  return patients;
}

/**
 * Get a specific patient by ID
 */
export async function getPatient(patientId: string): Promise<OpenEMRPatient | null> {
  try {
    const endpoint = `/apis/default/fhir/Patient/${patientId}`;
    
    const patient = await openEMRRequest<FHIRPatient>(endpoint);
    
    return convertFHIRPatient(patient);
  } catch (error) {
    console.error("Error getting patient:", (error as OpenEMRError).message);
    return null;
  }
}

/**
 * Get patient PID (numeric ID) from FHIR ID
 * Returns both FHIR ID and PID for an existing patient
 * Returns null if PID cannot be reliably determined
 */
export async function getPatientIds(fhirId: string): Promise<{ pid: string; fhirId: string } | null> {
  try {
    const endpoint = `/apis/default/fhir/Patient/${fhirId}`;
    console.log(`[OpenEMR] Fetching patient IDs for FHIR ID: ${fhirId}`);
    
    const patient = await openEMRRequest<FHIRPatient>(endpoint);
    
    // Try to extract PID from identifier array
    // OpenEMR typically includes the PID in the identifier array
    let pid: string | null = null;
    
    if (patient.identifier && patient.identifier.length > 0) {
      // Look for the medical record number identifier or system with "pid"
      const pidIdentifier = patient.identifier.find(
        (id) => {
          const isMRType = id.type?.coding?.[0]?.code === "MR";
          const hasPidSystem = id.system?.toLowerCase().includes("pid");
          const hasPatientSystem = id.system?.toLowerCase().includes("patient");
          return isMRType || hasPidSystem || hasPatientSystem;
        }
      );
      
      if (pidIdentifier?.value) {
        pid = pidIdentifier.value;
        console.log(`[OpenEMR] Found PID in identifiers: ${pid}`);
      } else {
        // If no specific identifier found, check if first identifier looks like a numeric PID
        const firstId = patient.identifier[0].value;
        if (firstId && /^\d+$/.test(firstId)) {
          pid = firstId;
          console.log(`[OpenEMR] Using first identifier as PID: ${pid}`);
        }
      }
    }
    
    // If we couldn't reliably extract PID, return null
    // The caller should create a new patient rather than risk using wrong PID
    if (!pid) {
      console.warn(`[OpenEMR] Could not reliably determine PID for patient ${fhirId}. Identifiers:`, 
        JSON.stringify(patient.identifier));
      return null;
    }
    
    console.log(`[OpenEMR] Successfully retrieved patient IDs - FHIR ID: ${patient.id}, PID: ${pid}`);
    
    return {
      pid,
      fhirId: patient.id,
    };
  } catch (error) {
    console.error(`[OpenEMR] Error getting patient IDs for ${fhirId}:`, (error as OpenEMRError).message);
    return null;
  }
}

export interface PatientAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

function toFHIRAddress(a: PatientAddress): FHIRPatient["address"] {
  if (!a.street && !a.city && !a.state && !a.postalCode) return undefined;
  return [
    {
      line: a.street ? [a.street] : undefined,
      city: a.city || undefined,
      state: a.state || undefined,
      postalCode: a.postalCode || undefined,
    },
  ];
}

/**
 * Update an existing patient in OpenEMR with language and address.
 * Insurance is not written here: OpenEMR drops unknown FHIR extensions, so
 * insurance goes through addPatientInsurance() instead.
 */
export async function updatePatient(fhirId: string, data: {
  primaryLanguage?: string;
} & PatientAddress): Promise<void> {
  // FHIR PUT replaces the whole resource, so start from what OpenEMR has
  const endpoint = `/apis/default/fhir/Patient/${fhirId}`;
  const existingPatient = await openEMRRequest<FHIRPatient>(endpoint);
  const updatedPatient: FHIRPatient = { ...existingPatient };

  if (data.primaryLanguage) {
    updatedPatient.communication = [
      {
        language: {
          text: data.primaryLanguage,
        },
        preferred: true,
      },
    ];
  }

  const address = toFHIRAddress(data);
  if (address) {
    updatedPatient.address = address;
  }

  console.log("[OpenEMR] Updating patient (language/address):", {
    fhirId,
    languageUpdated: !!data.primaryLanguage,
    addressUpdated: !!address,
  });

  try {
    if (!updatedPatient.meta) {
      updatedPatient.meta = {};
    }

    await openEMRRequest<FHIRPatient>(endpoint, {
      method: "PUT",
      headers: {
        "Content-Type": "application/fhir+json",
      },
      body: JSON.stringify(updatedPatient),
    });

    console.log(`[OpenEMR] Successfully updated patient ${fhirId}`);
  } catch (updateError: any) {
    const errorStatus = updateError.status;

    // Only confirmed server errors (5xx) are non-critical
    if (typeof errorStatus === 'number' && errorStatus >= 500 && errorStatus < 600) {
      console.warn(`[OpenEMR] Warning: Could not update patient ${fhirId} via FHIR PUT (server error ${errorStatus}). Language/address can be updated manually in OpenEMR.`);
      console.warn(`[OpenEMR] Update error:`, updateError.message || updateError);
      return;
    }

    // 4xx, network and unknown errors stop the sync
    console.error(`[OpenEMR] Critical: Patient update failed (status: ${errorStatus}) - cannot confirm patient was updated successfully`);
    console.error(`[OpenEMR] Error:`, updateError.message || updateError);
    throw updateError;
  }
}

// Demographics > Choices yes/no fields that referred patients default to YES.
// Prevent API Access (prevent_portal_apps) is deliberately left alone.
const DEFAULT_YES_CHOICES = [
  "hipaa_mail",
  "hipaa_allowsms",
  "hipaa_allowemail",
  "allow_imm_reg_use",
  "allow_imm_info_share",
  "allow_health_info_ex",
  "allow_patient_portal",
];

// OpenEMR's "sex" list option ids. A FHIR create stores "male"/"female" in
// lowercase, which matches none of them, so the Sex dropdown shows blank.
const SEX_OPTIONS = ["Male", "Female", "UNK"];

function toOpenEMRSex(gender?: string | null): string {
  const g = (gender || "").trim().toLowerCase();
  return g === "male" ? "Male" : g === "female" ? "Female" : "UNK";
}

/**
 * Sets the Choices above to YES, fixes Sex when it isn't a valid option, and
 * fills Mobile Phone when it's empty. On a patient the portal just created,
 * every Choice is set to YES (OpenEMR's own column default for Allow SMS and
 * Allow Email is NO). On an existing patient only blank Choices are filled,
 * so anything staff chose is kept. Returns an error message instead of throwing.
 */
export async function applyDemographicsDefaults(
  patientUuid: string,
  portal: { gender?: string | null; phone?: string | null; newPatient?: boolean }
): Promise<string | null> {
  const { gender } = portal;
  try {
    const endpoint = `/apis/default/api/patient/${patientUuid}`;
    const current = await openEMRRequest<any>(endpoint);
    const record = Array.isArray(current?.data) ? current.data[0] : current?.data;
    if (!record) throw new Error("patient not found");

    const updates: Record<string, string> = {};
    for (const field of DEFAULT_YES_CHOICES) {
      const current = String(record[field] ?? "").trim();
      if (current !== "YES" && (portal.newPatient || !current)) updates[field] = "YES";
    }
    const sex = String(record.sex ?? "").trim();
    if (!SEX_OPTIONS.includes(sex)) {
      // Keep what OpenEMR has (just fix the case); fall back to the referral's gender
      updates.sex = sex ? toOpenEMRSex(sex) : toOpenEMRSex(gender);
    }
    if (portal.phone?.trim() && !String(record.phone_cell ?? "").trim()) {
      updates.phone_cell = portal.phone.trim();
    }
    if (Object.keys(updates).length === 0) return null;

    const response = await openEMRRequest<any>(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const validation = response?.validationErrors;
    if (validation && (Array.isArray(validation) ? validation.length > 0 : Object.keys(validation).length > 0)) {
      throw new Error(JSON.stringify(validation));
    }
    console.log(`[OpenEMR] Updated demographics on patient ${patientUuid}:`, Object.keys(updates).join(", "));
    return null;
  } catch (error: any) {
    console.warn(`[OpenEMR] Could not update demographics on patient ${patientUuid}:`, error?.message || error);
    return "The patient's Birth Sex, Mobile Phone and Demographics > Choices could not be updated in OpenEMR.";
  }
}

/**
 * Demographics > Choices > Referring Provider (patient_data.ref_providerID,
 * an Address Book id). FHIR has no field for it, so this uses the REST API,
 * which updates only the columns sent. Returns an error message instead of throwing.
 */
export async function setPatientReferringProvider(
  patientUuid: string,
  addressBookId: string
): Promise<string | null> {
  try {
    const response = await openEMRRequest<any>(`/apis/default/api/patient/${patientUuid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref_providerID: addressBookId }),
    });
    const validation = response?.validationErrors;
    if (validation && (Array.isArray(validation) ? validation.length > 0 : Object.keys(validation).length > 0)) {
      throw new Error(JSON.stringify(validation));
    }
    return null;
  } catch (error: any) {
    console.warn(`[OpenEMR] Could not set referring provider on patient ${patientUuid}:`, error?.message || error);
    return "The patient's Referring Provider (Demographics > Choices) could not be set in OpenEMR.";
  }
}

/**
 * Create a new patient in OpenEMR
 * Returns both numeric PID and FHIR ID
 */
export async function createPatient(data: {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  email?: string;
  phone?: string;
  primaryLanguage?: string;
} & PatientAddress): Promise<{ pid: string; fhirId: string }> {
  const fhirPatient: FHIRPatient = {
    resourceType: "Patient",
    id: "",
    name: [
      {
        use: "official",
        family: data.lastName,
        given: [data.firstName],
      },
    ],
    gender: data.gender,
    birthDate: data.dateOfBirth,
  };

  // Only add telecom array if there's contact info
  if (data.email || data.phone) {
    fhirPatient.telecom = [];
    
    if (data.email) {
      fhirPatient.telecom.push({
        system: "email",
        value: data.email,
      });
    }

    if (data.phone) {
      // OpenEMR drops a phone without a `use`; mobile -> Mobile Phone (phone_cell)
      fhirPatient.telecom.push({
        system: "phone",
        value: data.phone,
        use: "mobile",
      });
    }
  }

  // Add primary language if provided
  if (data.primaryLanguage) {
    fhirPatient.communication = [
      {
        language: {
          text: data.primaryLanguage,
        },
        preferred: true,
      },
    ];
  }

  const address = toFHIRAddress(data);
  if (address) {
    fhirPatient.address = address;
  }

  const endpoint = "/apis/default/fhir/Patient";
  
  console.log("[OpenEMR] Creating patient with data:", JSON.stringify(fhirPatient, null, 2));
  
  const result = await openEMRRequest<FHIRPatient | { pid?: number; uuid?: string }>(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/fhir+json",
    },
    body: JSON.stringify(fhirPatient),
  });

  console.log("[OpenEMR] Patient creation response:", JSON.stringify(result, null, 2));

  let pid: string | undefined;
  let uuid: string | undefined;
  
  if ('pid' in result && result.pid) {
    pid = result.pid.toString();
  }
  if ('uuid' in result && result.uuid) {
    uuid = result.uuid;
  }
  if ('id' in result && result.id) {
    uuid = result.id;
  }

  if (!pid || !uuid) {
    console.error("[OpenEMR] Missing patient IDs in response. Full response:", result);
    throw new Error(`OpenEMR did not return complete patient IDs. PID: ${pid}, UUID: ${uuid}, Response: ${JSON.stringify(result)}`);
  }

  console.log("[OpenEMR] Patient created with PID:", pid, "UUID:", uuid);
  console.log("[OpenEMR] Fetching patient to verify FHIR ID...");
  
  try {
    const endpoint = `/apis/default/fhir/Patient/${uuid}`;
    const verifiedPatient = await openEMRRequest<FHIRPatient>(endpoint);
    
    if (!verifiedPatient?.id) {
      throw new Error(`Failed to verify patient ID. FHIR GET returned: ${JSON.stringify(verifiedPatient)}`);
    }
    
    console.log("[OpenEMR] Verified FHIR patient ID:", verifiedPatient.id);
    return {
      pid,
      fhirId: verifiedPatient.id,
    };
  } catch (error) {
    console.error("[OpenEMR] Failed to verify patient ID:", error);
    throw new Error(`Created patient but failed to retrieve canonical FHIR ID. PID: ${pid}, UUID: ${uuid}, Error: ${(error as Error).message}`);
  }
}

/**
 * Convert FHIR Patient resource to our simplified format
 */
function convertFHIRPatient(fhirPatient: FHIRPatient): OpenEMRPatient {
  const name = fhirPatient.name?.[0];
  const email = fhirPatient.telecom?.find((t) => t.system === "email")?.value;
  const phone = fhirPatient.telecom?.find((t) => t.system === "phone")?.value;

  // Extract and normalize gender (FHIR supports: male, female, other, unknown)
  // Only use if it's one of our supported values
  const fhirGender = fhirPatient.gender?.toLowerCase();
  const gender = (fhirGender === "male" || fhirGender === "female" || fhirGender === "other") 
    ? fhirGender 
    : undefined;

  // Extract primary language from communication
  const primaryLanguage = fhirPatient.communication?.[0]?.language?.text || 
    fhirPatient.communication?.[0]?.language?.coding?.[0]?.display;

  // Extract insurance information from extensions
  // Must match the hyphenated URLs we use when creating patients
  const extensionBase = "https://referralsystem.local/fhir/StructureDefinition/";
  const insurancePlan = fhirPatient.extension?.find(
    (ext) => ext.url === `${extensionBase}insurance-plan`
  )?.valueString;
  const policyNumber = fhirPatient.extension?.find(
    (ext) => ext.url === `${extensionBase}insurance-policy-number`
  )?.valueString;
  const groupNumber = fhirPatient.extension?.find(
    (ext) => ext.url === `${extensionBase}insurance-group-number`
  )?.valueString;
  const effectiveDate = fhirPatient.extension?.find(
    (ext) => ext.url === `${extensionBase}insurance-effective-date`
  )?.valueDate;

  return {
    id: fhirPatient.id,
    firstName: name?.given?.[0] || "",
    lastName: name?.family || "",
    dateOfBirth: fhirPatient.birthDate || "",
    gender,
    email,
    phone,
    primaryLanguage,
    insurancePlan,
    policyNumber,
    groupNumber,
    effectiveDate,
  };
}

interface RestResponse<T> {
  validationErrors?: unknown;
  internalErrors?: unknown;
  data?: T;
}

function restErrors(response: RestResponse<unknown> | undefined): string | null {
  const parts: string[] = [];
  for (const value of [response?.validationErrors, response?.internalErrors]) {
    if (!value) continue;
    if (Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value as object).length > 0 : true) {
      parts.push(JSON.stringify(value));
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Insurance plans in OpenEMR point at an Insurance Company record.
 * Match by name (case-insensitive); create one if it isn't there yet.
 */
async function findOrCreateInsuranceCompany(name: string): Promise<string> {
  const list = await openEMRRequest<RestResponse<Array<{ id?: string | number; name?: string }>>>(
    "/apis/default/api/insurance_company"
  );
  const wanted = name.trim().toLowerCase();
  const match = (Array.isArray(list?.data) ? list.data : []).find(
    (c) => (c.name || "").trim().toLowerCase() === wanted
  );
  if (match?.id) return String(match.id);

  console.log(`[OpenEMR] Insurance company "${name}" not found, creating it`);
  const created = await openEMRRequest<RestResponse<{ id?: string | number } | string | number>>(
    "/apis/default/api/insurance_company",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }
  );
  const errors = restErrors(created);
  if (errors) throw new Error(`OpenEMR rejected insurance company "${name}": ${errors}`);

  const data = created?.data;
  const id = typeof data === "object" && data !== null ? data.id : data;
  if (!id) throw new Error(`OpenEMR did not return an id for insurance company "${name}"`);
  return String(id);
}

export interface InsuranceResult {
  ok: boolean;
  skipped?: boolean;
  message?: string;
}

/**
 * Add the primary insurance policy to the patient's Insurance tab in OpenEMR.
 * Never throws: returns ok=false with a message the sync reports as a warning.
 */
export async function addPatientInsurance(patient: { uuid: string; pid: string }, data: {
  insurancePlan?: string;
  policyNumber?: string;
  groupNumber?: string;
  effectiveDate?: string;
  endDate?: string;
  subscriberRelationship?: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  subscriberDOB: string;
  subscriberSex: string;
  subscriberPhone?: string;
  subscriberSsn?: string | null;
  acceptAssignment?: boolean;
} & PatientAddress): Promise<InsuranceResult> {
  if (!data.insurancePlan || !data.policyNumber) {
    return { ok: false, message: "Insurance not sent to OpenEMR: plan name and policy number are both required." };
  }

  try {
    // Don't add the same policy twice (re-syncs, repeat referrals)
    try {
      const existing = await openEMRRequest<RestResponse<Array<{ policy_number?: string }>>>(
        `/apis/default/api/patient/${patient.uuid}/insurance`
      );
      const policies = Array.isArray(existing?.data) ? existing.data : [];
      if (policies.some((p) => (p.policy_number || "").trim() === data.policyNumber!.trim())) {
        console.log("[OpenEMR] Patient already has this insurance policy, skipping");
        return { ok: true, skipped: true };
      }
    } catch (lookupError: any) {
      console.warn("[OpenEMR] Could not list existing insurance, continuing:", lookupError.message);
    }

    const provider = await findOrCreateInsuranceCompany(data.insurancePlan);

    // OpenEMR's "sex" list uses capitalized option ids
    const sex = data.subscriberSex.toLowerCase() === "male" ? "Male"
      : data.subscriberSex.toLowerCase() === "female" ? "Female"
      : "UNK";

    const insurancePayload: Record<string, string> = {
      type: "primary",
      provider,
      plan_name: data.insurancePlan,
      policy_number: data.policyNumber,
      date: data.effectiveDate || new Date().toISOString().split('T')[0],
      // OpenEMR 8 requires an end date whenever a start date is sent.
      // Far-future keeps the policy current until staff edit it.
      date_end: data.endDate || "2099-12-31",
      subscriber_relationship: data.subscriberRelationship || "self",
      subscriber_fname: data.subscriberFirstName,
      subscriber_lname: data.subscriberLastName,
      subscriber_DOB: data.subscriberDOB,
      subscriber_sex: sex,
      subscriber_street: data.street || "",
      subscriber_city: data.city || "",
      subscriber_state: data.state || "",
      subscriber_postal_code: data.postalCode || "",
      accept_assignment: data.acceptAssignment === false ? "FALSE" : "TRUE",
    };
    // Optional fields must be left out rather than sent blank — OpenEMR
    // rejects empty values for them
    if (data.groupNumber) insurancePayload.group_number = data.groupNumber;
    if (data.subscriberPhone) insurancePayload.subscriber_phone = data.subscriberPhone;
    if (data.subscriberSsn) insurancePayload.subscriber_ss = data.subscriberSsn;

    console.log("[OpenEMR] Adding insurance for patient:", patient.uuid);

    // OpenEMR 7.0.2+ takes the patient UUID with type in the body;
    // older versions use /patient/:pid/insurance/:type
    let result: RestResponse<unknown>;
    try {
      result = await openEMRRequest<RestResponse<unknown>>(
        `/apis/default/api/patient/${patient.uuid}/insurance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(insurancePayload),
        }
      );
    } catch (error: any) {
      if (error.status !== 404 && error.status !== 405) throw error;
      result = await openEMRRequest<RestResponse<unknown>>(
        `/apis/default/api/patient/${patient.pid}/insurance/primary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(insurancePayload),
        }
      );
    }

    const errors = restErrors(result);
    if (errors) {
      const missingAddress = !data.street || !data.city || !data.state || !data.postalCode;
      return {
        ok: false,
        message: `OpenEMR rejected the insurance${missingAddress ? " (patient address is missing)" : ""}: ${errors}`,
      };
    }

    console.log("[OpenEMR] Insurance added successfully");
    return { ok: true };
  } catch (error: any) {
    const status = error.status;
    const message = status === 401 || status === 403
      ? "Insurance not saved: the OpenEMR connection lacks insurance permissions. Reconnect OpenEMR from the admin page."
      : `Insurance not saved: ${error.message || error}`;
    console.warn("[OpenEMR]", message);
    return { ok: false, message };
  }
}
