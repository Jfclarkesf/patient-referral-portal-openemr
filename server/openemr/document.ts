import { getAccessToken, getApiBaseUrl, getOpenEMRConfig } from "./client";
import { storage } from "../storage";
import type { EncounterDocument } from "@shared/schema";

// OpenEMR document category the files go into, as a path of category names.
// OpenEMR reads "_" as a space, so "/Medical_Record" also works.
function documentCategoryPath(): string {
  return process.env.OPENEMR_DOCUMENT_CATEGORY || "/Medical Record";
}

/**
 * Upload one file to the patient's documents in OpenEMR
 * (POST /api/patient/:pid/document?path=..., multipart field "document").
 * Throws with a readable message on failure.
 */
export async function uploadDocumentToPatient(patientPid: string, doc: EncounterDocument): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("Not connected to OpenEMR. An admin needs to connect it again.");
  }

  const url = new URL(`${getApiBaseUrl()}/apis/default/api/patient/${encodeURIComponent(patientPid)}/document`);
  url.searchParams.set("path", documentCategoryPath());

  const form = new FormData();
  form.append("document", new Blob([Buffer.from(doc.content, "base64")], { type: doc.contentType }), doc.fileName);

  console.log(`[OpenEMR] Uploading document "${doc.fileName}" (${doc.size} bytes) to patient PID ${patientPid}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[OpenEMR] Document upload failed: ${response.status}`, text.slice(0, 500));
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenEMR refused the upload. Reconnect OpenEMR so the app gets document access.");
    }
    if (response.status === 400) {
      throw new Error(`OpenEMR rejected the file. Check that the document category "${documentCategoryPath()}" exists.`);
    }
    throw new Error(`OpenEMR returned ${response.status} for the upload.`);
  }
}

/**
 * Send every not-yet-synced document of a referral to the patient's chart.
 * Each file's result is saved on its row, so a retry only resends the failures.
 */
export async function syncEncounterDocuments(
  encounterId: string,
  patientPid: string | null | undefined
): Promise<{ uploaded: number; failed: number; error?: string }> {
  const pending = await storage.getUnsyncedDocumentsForEncounter(encounterId);
  if (pending.length === 0) return { uploaded: 0, failed: 0 };

  if (!getOpenEMRConfig() || !patientPid) {
    const error = !patientPid ? "The patient isn't in OpenEMR yet." : "OpenEMR isn't set up.";
    for (const doc of pending) await storage.updateDocumentSync(doc.id, "failed", error);
    return { uploaded: 0, failed: pending.length, error };
  }

  let uploaded = 0;
  let lastError: string | undefined;
  for (const doc of pending) {
    try {
      await uploadDocumentToPatient(patientPid, doc);
      await storage.updateDocumentSync(doc.id, "synced", null);
      uploaded++;
    } catch (error: any) {
      lastError = error?.message || String(error);
      await storage.updateDocumentSync(doc.id, "failed", lastError ?? null);
    }
  }

  const failed = pending.length - uploaded;
  console.log(`[OpenEMR] Documents for encounter ${encounterId}: ${uploaded} uploaded, ${failed} failed`);
  return { uploaded, failed, error: failed ? lastError : undefined };
}
