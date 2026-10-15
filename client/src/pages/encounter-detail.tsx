import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import type { Encounter, EncounterDocumentInfo, Patient } from "@shared/schema";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { formatFileSize } from "@/components/document-upload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, FileText, Calendar, UserCheck, Activity, Download, RefreshCw } from "lucide-react";
import { format } from "date-fns";

export default function EncounterDetail() {
  const [, params] = useRoute("/encounters/:referenceNumber");
  const [, setLocation] = useLocation();
  const referenceNumber = params?.referenceNumber;

  const { data: encounter, isLoading: encounterLoading } = useQuery<Encounter>({
    queryKey: ["/api/encounters", referenceNumber],
    enabled: !!referenceNumber,
  });

  const { data: patient, isLoading: patientLoading } = useQuery<Patient>({
    queryKey: ["/api/patients", encounter?.patientId],
    enabled: !!encounter?.patientId,
  });

  const { user } = useAuth();
  const { toast } = useToast();
  const documentsKey = ["/api/encounters", referenceNumber, "documents"];
  const { data: documents } = useQuery<EncounterDocumentInfo[]>({
    queryKey: documentsKey,
    enabled: !!referenceNumber,
  });
  const unsyncedDocuments = documents?.filter((d) => d.openemrSyncStatus !== "synced").length ?? 0;

  const resendDocuments = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/encounters/${referenceNumber}/documents/sync`, {
        method: "POST",
        credentials: "include",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Couldn't send the files to OpenEMR.");
      return result as { message: string };
    },
    onSuccess: (result) => toast({ title: "Documents sent", description: result.message }),
    onError: (error: Error) => toast({ title: "Upload failed", description: error.message, variant: "destructive" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey }),
  });

  const getUrgencyVariant = (urgency: string) => {
    switch (urgency) {
      case "emergency":
        return "destructive";
      case "urgent":
        return "default";
      default:
        return "secondary";
    }
  };

  const formatDateTime = (date: string | Date) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (encounterLoading || patientLoading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Skeleton className="h-8 w-64 mb-6" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!encounter) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Card>
          <CardContent className="py-12 text-center">
            <h3 className="text-lg font-semibold mb-2">Encounter not found</h3>
            <p className="text-muted-foreground mb-4">
              The encounter you're looking for doesn't exist
            </p>
            <Button
              onClick={() => setLocation("/patients")}
              data-testid="button-back-to-patients"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Patients
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <Button
          variant="ghost"
          onClick={() => setLocation(encounter.patientId ? `/patients/${encounter.patientId}` : "/patients")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Patient Profile
        </Button>
        <Badge variant={getUrgencyVariant(encounter.urgency)} data-testid="badge-urgency">
          {encounter.urgency.charAt(0).toUpperCase() + encounter.urgency.slice(1)}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Encounter Details</CardTitle>
              <CardDescription>
                Reference: <span className="font-mono" data-testid="text-reference-number">{encounter.referenceNumber}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Diagnosis</p>
                <p className="text-base font-medium" data-testid="text-diagnosis">
                  {encounter.diagnosis}
                </p>
              </div>

              {encounter.encounterType && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Encounter Type</p>
                    <p className="text-base font-medium capitalize" data-testid="text-encounter-type">
                      {encounter.encounterType}
                    </p>
                  </div>
                </>
              )}

              {encounter.icd10Code && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">ICD-10 Code</p>
                    <p className="text-base font-medium" data-testid="text-icd10-code">
                      {encounter.icd10Code}
                    </p>
                  </div>
                </>
              )}

              {encounter.referralReason && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Referral Reason</p>
                    <p className="text-base whitespace-pre-wrap" data-testid="text-referral-reason">
                      {encounter.referralReason}
                    </p>
                  </div>
                </>
              )}

              {encounter.medicalHistory && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Medical History</p>
                    <p className="text-base whitespace-pre-wrap" data-testid="text-medical-history">
                      {encounter.medicalHistory}
                    </p>
                  </div>
                </>
              )}

              {encounter.currentMedications && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Current Medications</p>
                    <p className="text-base whitespace-pre-wrap" data-testid="text-medications">
                      {encounter.currentMedications}
                    </p>
                  </div>
                </>
              )}

              {(encounter.insurancePlan || encounter.policyNumber || encounter.groupNumber || encounter.effectiveDate) && (
                <>
                  <Separator />
                  <div>
                    <h3 className="text-sm font-semibold mb-3">Insurance Information</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {encounter.insurancePlan && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Insurance Plan</p>
                          <p className="text-base" data-testid="text-insurance-plan">
                            {encounter.insurancePlan}
                          </p>
                        </div>
                      )}
                      {encounter.policyNumber && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Policy Number</p>
                          <p className="text-base" data-testid="text-policy-number">
                            {encounter.policyNumber}
                          </p>
                        </div>
                      )}
                      {encounter.groupNumber && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Group Number</p>
                          <p className="text-base" data-testid="text-group-number">
                            {encounter.groupNumber}
                          </p>
                        </div>
                      )}
                      {encounter.effectiveDate && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Effective Date</p>
                          <p className="text-base" data-testid="text-effective-date">
                            {format(new Date(encounter.effectiveDate), "MMMM d, yyyy")}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {patient && (
            <Card>
              <CardHeader>
                <CardTitle>Patient Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Name</p>
                  <p className="text-base font-medium" data-testid="text-patient-name">
                    {patient.firstName} {patient.lastName}
                  </p>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  {patient.dateOfBirth && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Date of Birth</p>
                      <p className="text-base" data-testid="text-patient-dob">
                        {format(new Date(patient.dateOfBirth), "MMMM d, yyyy")}
                      </p>
                    </div>
                  )}
                  {patient.gender && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Gender</p>
                      <p className="text-base capitalize" data-testid="text-patient-gender">
                        {patient.gender}
                      </p>
                    </div>
                  )}
                </div>

                {(patient.email || patient.phone) && (
                  <>
                    <Separator />
                    <div className="grid grid-cols-2 gap-4">
                      {patient.email && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Email</p>
                          <p className="text-base break-all" data-testid="text-patient-email">
                            {patient.email}
                          </p>
                        </div>
                      )}
                      {patient.phone && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Phone</p>
                          <p className="text-base" data-testid="text-patient-phone">
                            {patient.phone}
                          </p>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Encounter Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Submitted</p>
                  <p className="text-sm text-muted-foreground" data-testid="text-submitted-at">
                    {formatDateTime(encounter.submittedAt)}
                  </p>
                </div>
              </div>

              {encounter.openemrPractitioner && (
                <>
                  <Separator />
                  <div className="flex items-start gap-3">
                    <UserCheck className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Provider</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-practitioner">
                        {encounter.openemrPractitioner}
                      </p>
                    </div>
                  </div>
                </>
              )}

              {encounter.referringProvider && encounter.referringProvider.trim() && (
                <>
                  <Separator />
                  <div className="flex items-start gap-3">
                    <UserCheck className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Referring Provider</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-referring-provider">
                        {encounter.referringProvider}
                      </p>
                    </div>
                  </div>
                </>
              )}

              {encounter.syncStatus && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-2">Sync Status</p>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={encounter.syncStatus === "synced" ? "default" : "secondary"}
                        data-testid="badge-sync-status"
                      >
                        {encounter.syncStatus}
                      </Badge>
                      {encounter.userId === "SYSTEM_IMPORT" && (
                        <Badge variant="outline" data-testid="badge-imported">
                          Imported
                        </Badge>
                      )}
                    </div>
                    {encounter.syncError && encounter.syncStatus !== "synced" && (
                      <p className="text-sm text-muted-foreground mt-2" data-testid="text-sync-error">
                        {encounter.syncError}
                      </p>
                    )}
                  </div>
                </>
              )}

              {encounter.openemrEncounterId && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-1">OpenEMR Encounter ID</p>
                    <Badge variant="outline" className="font-mono" data-testid="badge-openemr-encounter-id">
                      {encounter.openemrEncounterId}
                    </Badge>
                  </div>
                </>
              )}

              {encounter.openemrPractitionerId && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-1">OpenEMR Practitioner ID</p>
                    <Badge variant="outline" className="font-mono" data-testid="badge-openemr-practitioner-id">
                      {encounter.openemrPractitionerId}
                    </Badge>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {documents && documents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Documents
                </CardTitle>
                <CardDescription data-testid="text-document-count">
                  {documents.length - unsyncedDocuments} of {documents.length} in OpenEMR
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="divide-y rounded-md border" data-testid="list-encounter-documents">
                  {documents.map((doc) => (
                    <li key={doc.id} className="flex items-center gap-3 p-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{doc.fileName}</p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(doc.size)}</p>
                        {doc.openemrSyncError && doc.openemrSyncStatus !== "synced" && (
                          <p className="text-xs text-destructive mt-1">{doc.openemrSyncError}</p>
                        )}
                      </div>
                      <Badge variant={doc.openemrSyncStatus === "synced" ? "default" : "secondary"}>
                        {doc.openemrSyncStatus === "synced" ? "In OpenEMR" : doc.openemrSyncStatus === "failed" ? "Not sent" : "Pending"}
                      </Badge>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" asChild>
                        <a href={`/api/documents/${doc.id}/file`} aria-label={`Download ${doc.fileName}`} data-testid="link-download-document">
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
                {user?.isAdmin && unsyncedDocuments > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resendDocuments.mutate()}
                    disabled={resendDocuments.isPending}
                    data-testid="button-resend-documents"
                  >
                    <RefreshCw className={`mr-2 h-4 w-4 ${resendDocuments.isPending ? "animate-spin" : ""}`} />
                    Send {unsyncedDocuments} to OpenEMR
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
