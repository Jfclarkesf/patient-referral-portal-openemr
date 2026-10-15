import { openEMRRequest } from "./client";

/**
 * Patient "Issues" lists in OpenEMR — the Medical Problems and Medications
 * cards on the patient dashboard (interface/patient_file/summary/demographics.php).
 *
 * Requires the OAuth token to carry user/medical_problem.* and user/medication.*.
 */

interface RestResponse<T> {
  validationErrors?: unknown;
  internalErrors?: unknown;
  data?: T;
}

interface IssueRecord {
  title?: string;
}

export interface IssueListResult {
  added: number;
  skipped: number;
  failed: string[];
  error?: string;
}

type IssueKind = "medical_problem" | "medication";

const LABELS: Record<IssueKind, string> = {
  medical_problem: "medical history",
  medication: "medications",
};

function hasErrors(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * One entry per line (or semicolon). Leading bullets and numbering are dropped.
 */
export function splitEntries(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of text.split(/[\r\n;]+/)) {
    const entry = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim().slice(0, 255);
    const key = entry.toLowerCase();
    // OpenEMR rejects titles shorter than 2 characters
    if (entry.length < 2 || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/**
 * Medical problems are addressed by patient UUID; medications by numeric pid
 * on OpenEMR 7.x. Try the documented form first and fall back to the other,
 * so newer versions that switched to UUIDs still work.
 */
function endpointsFor(kind: IssueKind, patient: { uuid: string; pid: string }): string[] {
  const byUuid = `/apis/default/api/patient/${patient.uuid}/${kind}`;
  const byPid = `/apis/default/api/patient/${patient.pid}/${kind}`;
  return kind === "medical_problem" ? [byUuid, byPid] : [byPid, byUuid];
}

async function resolveEndpoint(
  kind: IssueKind,
  patient: { uuid: string; pid: string }
): Promise<{ endpoint: string; existing: IssueRecord[] }> {
  let lastError: any;
  for (const endpoint of endpointsFor(kind, patient)) {
    try {
      const response = await openEMRRequest<RestResponse<IssueRecord[] | IssueRecord>>(endpoint);
      const data = response?.data;
      return { endpoint, existing: Array.isArray(data) ? data : data ? [data] : [] };
    } catch (error: any) {
      lastError = error;
      // Wrong id form for this OpenEMR version — try the other one
      if (error.status === 400 || error.status === 404) continue;
      throw error;
    }
  }
  throw lastError;
}

async function addIssues(
  kind: IssueKind,
  patient: { uuid: string; pid: string },
  text: string | null | undefined,
  begdate: string
): Promise<IssueListResult> {
  const entries = splitEntries(text);
  const result: IssueListResult = { added: 0, skipped: 0, failed: [] };
  if (entries.length === 0) return result;

  let endpoint: string;
  let existing: IssueRecord[];
  try {
    ({ endpoint, existing } = await resolveEndpoint(kind, patient));
  } catch (error: any) {
    result.failed = entries;
    result.error = error.status === 401 || error.status === 403
      ? `${LABELS[kind]} not saved: the OpenEMR connection lacks permission. Reconnect OpenEMR from the admin page.`
      : `${LABELS[kind]} not saved: ${error.message || error}`;
    return result;
  }

  const already = new Set(existing.map((i) => (i.title || "").trim().toLowerCase()));

  for (const title of entries) {
    if (already.has(title.toLowerCase())) {
      result.skipped++;
      continue;
    }
    try {
      const response = await openEMRRequest<RestResponse<unknown>>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // OpenEMR rejects optional fields sent empty, so diagnosis/enddate are
        // left out. Medications validate begdate as a datetime, problems as a date.
        body: JSON.stringify({
          title,
          begdate: kind === "medication" ? `${begdate} 00:00:00` : begdate,
        }),
      });
      if (hasErrors(response?.validationErrors) || hasErrors(response?.internalErrors)) {
        throw new Error(JSON.stringify({
          validationErrors: response?.validationErrors,
          internalErrors: response?.internalErrors,
        }));
      }
      result.added++;
    } catch (error: any) {
      console.warn(`[OpenEMR] Failed to add ${kind} "${title}":`, error.message || error);
      result.failed.push(title);
      result.error ??= `Some ${LABELS[kind]} entries were not saved: ${error.message || error}`;
    }
  }

  console.log(`[OpenEMR] ${kind}: added ${result.added}, already present ${result.skipped}, failed ${result.failed.length}`);
  return result;
}

/**
 * begdate is required by OpenEMR; we don't know true onset, so use the referral date.
 */
export function addMedicalProblems(patient: { uuid: string; pid: string }, text: string | null | undefined, begdate: string) {
  return addIssues("medical_problem", patient, text, begdate);
}

export function addMedications(patient: { uuid: string; pid: string }, text: string | null | undefined, begdate: string) {
  return addIssues("medication", patient, text, begdate);
}
