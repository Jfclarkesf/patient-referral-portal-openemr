import { openEMRRequest } from "./client";
import type { FHIRPatient } from "./patient";

/**
 * SSN handling for insurance subscribers.
 *
 * OpenEMR's insurance form marks S.S. as required, so when the referral has
 * none we use a placeholder from the 999-xx-xxxx range, which the SSA never
 * issues — it can't collide with a real person's number. Staff are expected
 * to replace placeholders with the real SSN before billing.
 *
 * For a "self" subscriber OpenEMR checks that the subscriber SSN equals the
 * patient's SSN, so the patient record has to carry the same number.
 */

const SSN_SYSTEM = "http://hl7.org/fhir/sid/us-ssn";
const PLACEHOLDER_COUNTER = "placeholder_ssn";

export function isPlaceholderSsn(ssn: string | null | undefined): boolean {
  return !!ssn && ssn.startsWith("999-");
}

function isSsnIdentifier(identifier: NonNullable<FHIRPatient["identifier"]>[number]): boolean {
  return identifier.system === SSN_SYSTEM || !!identifier.type?.coding?.some((c) => c.code === "SS");
}

async function ssnInUse(ssn: string): Promise<boolean> {
  const bundle = await openEMRRequest<{ entry?: unknown[] }>(
    `/apis/default/fhir/Patient?identifier=${encodeURIComponent(ssn)}`
  );
  return (bundle?.entry?.length ?? 0) > 0;
}

/**
 * Next unused placeholder: 999-00-0001, 999-00-0002, ...
 * Skips any number already on a patient in OpenEMR (e.g. after a DB restore).
 */
export async function nextPlaceholderSsn(): Promise<string> {
  const { storage } = await import("../storage");
  for (let attempt = 0; attempt < 25; attempt++) {
    const n = await storage.nextCounterValue(PLACEHOLDER_COUNTER);
    if (n > 999999) throw new Error("Placeholder SSN range exhausted");
    const digits = String(n).padStart(6, "0");
    const ssn = `999-${digits.slice(0, 2)}-${digits.slice(2)}`;
    if (!(await ssnInUse(ssn))) return ssn;
  }
  throw new Error("Could not find an unused placeholder SSN");
}

export async function getPatientSsn(fhirId: string): Promise<string | null> {
  const patient = await openEMRRequest<FHIRPatient>(`/apis/default/fhir/Patient/${fhirId}`);
  return patient.identifier?.find(isSsnIdentifier)?.value || null;
}

export async function setPatientSsn(fhirId: string, ssn: string): Promise<void> {
  const endpoint = `/apis/default/fhir/Patient/${fhirId}`;
  const patient = await openEMRRequest<FHIRPatient>(endpoint);
  const others = (patient.identifier || []).filter((i) => !isSsnIdentifier(i));
  const updated: FHIRPatient = {
    ...patient,
    meta: patient.meta || {},
    identifier: [
      ...others,
      {
        system: SSN_SYSTEM,
        value: ssn,
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "SS" }] },
      },
    ],
  };
  await openEMRRequest<FHIRPatient>(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(updated),
  });
}

export interface SubscriberSsn {
  ssn: string | null; // what to send as subscriber_ss (null = leave out)
  warning?: string;
}

/**
 * Work out the subscriber SSN to send, updating the patient's SSN in OpenEMR
 * for "self" subscribers when needed. Never throws.
 */
export async function resolveSubscriberSsn(
  patientFhirId: string,
  relationship: string,
  entered: string | null | undefined
): Promise<SubscriberSsn> {
  try {
    if (relationship !== "self") {
      return { ssn: entered || (await nextPlaceholderSsn()) };
    }

    const current = await getPatientSsn(patientFhirId);

    if (!entered) {
      // Reuse whatever the patient already has (real or placeholder)
      if (current) return { ssn: current };
      const placeholder = await nextPlaceholderSsn();
      await setPatientSsn(patientFhirId, placeholder);
      return { ssn: placeholder };
    }

    if (!current || current === entered || isPlaceholderSsn(current)) {
      if (current !== entered) await setPatientSsn(patientFhirId, entered);
      return { ssn: entered };
    }

    // Patient already has a different real SSN — don't overwrite it. Sending no
    // subscriber SSN skips OpenEMR's match check so the insurance still saves.
    return {
      ssn: null,
      warning: "The SSN on the referral doesn't match the patient's SSN in OpenEMR; insurance was saved without an SSN. Please check it in OpenEMR.",
    };
  } catch (error: any) {
    return { ssn: entered || null, warning: `Could not set the subscriber SSN: ${error.message || error}` };
  }
}
