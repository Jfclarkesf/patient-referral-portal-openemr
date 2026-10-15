import { openEMRRequest } from "./client";
import { lookupNpi } from "../nppes";

/**
 * Referring providers live in OpenEMR's Address Book.
 * POST /apis/default/api/practitioner creates an Address Book entry that
 * shows up in the patient's Referring Provider dropdown (verified in Postman,
 * test record id 7).
 *
 * Requires the portal's OAuth token to carry user/practitioner.read and
 * user/practitioner.write.
 */

export interface PractitionerInput {
  npi: string;
  firstName: string;
  lastName: string;
  credential?: string | null;
  specialty?: string | null;
  practiceName?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
}

export interface PractitionerLink {
  id: string;
  uuid: string | null;
  created: boolean;
}

interface PractitionerRecord {
  id?: string | number;
  uuid?: string;
  npi?: string;
}

interface OpenEMRRestResponse<T> {
  validationErrors?: unknown;
  internalErrors?: unknown;
  data?: T;
}

function hasErrors(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

// Only physicians get "Dr." — NPs, PAs, etc. do not
function titleFor(credential?: string | null): string {
  if (!credential) return "";
  return /\b(MD|DO|DPM|DDS|DMD|PHD)\b/i.test(credential.replace(/\./g, "")) ? "Dr." : "";
}

export async function findPractitionerByNpi(npi: string): Promise<PractitionerRecord | null> {
  const response = await openEMRRequest<OpenEMRRestResponse<PractitionerRecord[]>>(
    `/apis/default/api/practitioner?npi=${encodeURIComponent(npi)}`
  );

  const list = Array.isArray(response?.data) ? response.data : [];
  // Match exactly in case the search parameter is ignored and everything comes back
  return list.find((p) => String(p.npi ?? "").trim() === npi) ?? null;
}

export async function createPractitioner(input: PractitionerInput): Promise<PractitionerRecord> {
  const body = {
    title: titleFor(input.credential),
    fname: input.firstName,
    lname: input.lastName,
    npi: input.npi,
    specialty: input.specialty || "",
    organization: input.practiceName || "",
    street: input.street || "",
    city: input.city || "",
    state: input.state || "",
    zip: input.zip || "",
    phone: input.phone || "",
    fax: input.fax || "",
    email: input.email || "",
  };

  const response = await openEMRRequest<OpenEMRRestResponse<PractitionerRecord>>(
    "/apis/default/api/practitioner",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (hasErrors(response?.validationErrors) || hasErrors(response?.internalErrors)) {
    throw new Error(
      `OpenEMR rejected the practitioner: ${JSON.stringify({
        validationErrors: response?.validationErrors,
        internalErrors: response?.internalErrors,
      })}`
    );
  }

  if (!response?.data?.id) {
    throw new Error("OpenEMR did not return a practitioner id");
  }

  return response.data;
}

/**
 * Find by NPI first; create only if missing. NPI is the only matching key —
 * never match on name.
 */
export async function findOrCreatePractitioner(input: PractitionerInput): Promise<PractitionerLink> {
  const existing = await findPractitionerByNpi(input.npi);
  if (existing?.id) {
    return { id: String(existing.id), uuid: existing.uuid ?? null, created: false };
  }

  const created = await createPractitioner(input);
  return { id: String(created.id), uuid: created.uuid ?? null, created: true };
}

/**
 * For a referring provider typed on a referral (not a portal account): find by
 * NPI, else create from the national NPI registry record. `contactPhone` is
 * used only when the registry has no phone.
 */
export async function findOrCreatePractitionerFromRegistry(
  npi: string,
  contactPhone?: string | null
): Promise<PractitionerLink> {
  const existing = await findPractitionerByNpi(npi);
  if (existing?.id) {
    return { id: String(existing.id), uuid: existing.uuid ?? null, created: false };
  }

  const registry = await lookupNpi(npi);
  if (!registry) {
    throw new Error(`NPI ${npi} is not in the national NPI registry`);
  }
  if (registry.type !== "individual") {
    throw new Error(`NPI ${npi} belongs to an organization, not an individual provider`);
  }

  const created = await createPractitioner({
    npi,
    firstName: registry.firstName,
    lastName: registry.lastName,
    credential: registry.credential,
    specialty: registry.specialty,
    practiceName: registry.practiceName,
    street: registry.street,
    city: registry.city,
    state: registry.state,
    zip: registry.zip,
    phone: registry.phone || contactPhone,
    fax: registry.fax,
  });
  return { id: String(created.id), uuid: created.uuid ?? null, created: true };
}
