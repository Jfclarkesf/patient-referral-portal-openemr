import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import type { Referral } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ClipboardCheck, FileText, User, Calendar, Phone, Mail, RefreshCw, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export default function ReferralDetail() {
  const [, params] = useRoute("/referrals/:referenceNumber");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const referenceNumber = params?.referenceNumber;

  const { data: referral, isLoading } = useQuery<Referral>({
    queryKey: ["/api/referrals", referenceNumber],
    enabled: !!referenceNumber,
  });

  const syncToOpenEMRMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/openemr/sync/${referenceNumber}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error || `Sync failed with status ${response.status}`);
      }
      return await response.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ 
        queryKey: ["/api/referrals", referenceNumber],
        refetchType: 'all'
      });
      toast({
        title: "Sync Successful",
        description: "Referral has been synced to OpenEMR",
      });
    },
    onError: async (error: Error) => {
      // Invalidate cache to show any error details stored in the database
      await queryClient.invalidateQueries({ 
        queryKey: ["/api/referrals", referenceNumber],
        refetchType: 'all'
      });
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync referral to OpenEMR. Check the error details below and try again.",
        variant: "destructive",
      });
    },
  });

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "emergency":
        return "destructive";
      case "urgent":
        return "default";
      default:
        return "secondary";
    }
  };

  const getSyncStatusIcon = (status?: string | null) => {
    switch (status) {
      case "synced":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case "partial":
        return <CheckCircle2 className="h-4 w-4 text-yellow-600" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-600" />;
      case "pending":
        return <AlertCircle className="h-4 w-4 text-yellow-600" />;
      default:
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getSyncStatusText = (status?: string | null) => {
    switch (status) {
      case "synced":
        return "Synced";
      case "partial":
        return "Partially Synced";
      case "failed":
        return "Failed";
      case "pending":
        return "Pending";
      default:
        return "Not Synced";
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <Skeleton className="h-8 w-64" />
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-96 w-full" />
        </main>
      </div>
    );
  }

  if (!referral) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Referral not found</p>
            <Button className="w-full mt-4" onClick={() => setLocation("/")} data-testid="button-back-to-list">
              Back to Referrals
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-3">
            <ClipboardCheck className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-3xl font-medium text-foreground">Referral Details</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Reference: <span className="font-mono">{referral.referenceNumber}</span>
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Button variant="outline" onClick={() => setLocation("/")} data-testid="button-back">
            ← Back to Referrals
          </Button>
          <Badge variant={getUrgencyColor(referral.urgency)} className="text-base px-4 py-1" data-testid="badge-urgency">
            {referral.urgency.charAt(0).toUpperCase() + referral.urgency.slice(1)}
          </Badge>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl">Patient Information</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Full Name</p>
                    <p className="text-base font-medium text-foreground" data-testid="text-patient-name">
                      {referral.firstName} {referral.lastName}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Date of Birth</p>
                    <p className="text-base font-medium text-foreground" data-testid="text-date-of-birth">
                      {format(new Date(referral.dateOfBirth), "MMMM d, yyyy")}
                    </p>
                  </div>
                </div>

                <Separator />

                <div>
                  <p className="text-sm text-muted-foreground mb-1">Gender</p>
                  <p className="text-base font-medium text-foreground capitalize" data-testid="text-gender">
                    {referral.gender}
                  </p>
                </div>

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Email</p>
                      <p className="text-base text-foreground" data-testid="text-email">{referral.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Phone</p>
                      <p className="text-base text-foreground" data-testid="text-phone">{referral.phone}</p>
                    </div>
                  </div>
                </div>

                {referral.primaryLanguage && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Primary Language</p>
                      <p className="text-base font-medium text-foreground" data-testid="text-primary-language">
                        {referral.primaryLanguage}
                      </p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl">Medical Details</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Diagnosis</p>
                  <p className="text-base font-medium text-foreground" data-testid="text-diagnosis">{referral.diagnosis}</p>
                </div>

                {referral.medicalHistory && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Medical History</p>
                      <p className="text-base text-foreground whitespace-pre-wrap" data-testid="text-medical-history">
                        {referral.medicalHistory}
                      </p>
                    </div>
                  </>
                )}

                {referral.currentMedications && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Current Medications</p>
                      <p className="text-base text-foreground whitespace-pre-wrap" data-testid="text-medications">
                        {referral.currentMedications}
                      </p>
                    </div>
                  </>
                )}

                {referral.icd10Code && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">ICD-10 Code</p>
                      <p className="text-base font-medium text-foreground" data-testid="text-icd10-code">
                        {referral.icd10Code}
                      </p>
                    </div>
                  </>
                )}

                {referral.referralReason && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Referral Reason</p>
                      <p className="text-base text-foreground whitespace-pre-wrap" data-testid="text-referral-reason">
                        {referral.referralReason}
                      </p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {(referral.insurancePlan || referral.policyNumber || referral.groupNumber || referral.effectiveDate) && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <ClipboardCheck className="h-5 w-5 text-primary" />
                    <CardTitle className="text-xl">Insurance Information</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {referral.insurancePlan && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Insurance Plan</p>
                      <p className="text-base font-medium text-foreground" data-testid="text-insurance-plan">
                        {referral.insurancePlan}
                      </p>
                    </div>
                  )}

                  {(referral.policyNumber || referral.groupNumber) && (
                    <>
                      {referral.insurancePlan && <Separator />}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {referral.policyNumber && (
                          <div>
                            <p className="text-sm text-muted-foreground mb-1">Policy Number</p>
                            <p className="text-base font-medium text-foreground" data-testid="text-policy-number">
                              {referral.policyNumber}
                            </p>
                          </div>
                        )}
                        {referral.groupNumber && (
                          <div>
                            <p className="text-sm text-muted-foreground mb-1">Group Number</p>
                            <p className="text-base font-medium text-foreground" data-testid="text-group-number">
                              {referral.groupNumber}
                            </p>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {referral.effectiveDate && (
                    <>
                      <Separator />
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Effective Date</p>
                        <p className="text-base font-medium text-foreground" data-testid="text-effective-date">
                          {format(new Date(referral.effectiveDate), "MMMM d, yyyy")}
                        </p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl">Referring Provider</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Provider Name</p>
                  <p className="text-base font-medium text-foreground" data-testid="text-provider-name">
                    {referral.referringProvider}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Contact Information</p>
                  <p className="text-base text-foreground" data-testid="text-provider-contact">{referral.providerContact}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Submission Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Status</p>
                  <Badge variant="secondary" data-testid="badge-status">
                    {referral.status.charAt(0).toUpperCase() + referral.status.slice(1)}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Submitted On</p>
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <p className="text-base text-foreground" data-testid="text-submitted-date">
                      {format(new Date(referral.submittedAt), "MMMM d, yyyy")}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">OpenEMR Sync</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Sync Status</p>
                  <div className="flex items-center gap-2">
                    {getSyncStatusIcon(referral.syncStatus)}
                    <span className="text-base font-medium" data-testid="text-sync-status">
                      {getSyncStatusText(referral.syncStatus)}
                    </span>
                  </div>
                  {referral.lastSyncedAt && (
                    <p className="text-xs text-muted-foreground mt-1" data-testid="text-last-synced">
                      Last synced: {format(new Date(referral.lastSyncedAt), "MMM d, yyyy h:mm a")}
                    </p>
                  )}
                </div>

                {referral.syncError && (
                  <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3">
                    <p className="text-sm text-destructive" data-testid="text-sync-error">
                      {referral.syncError}
                    </p>
                  </div>
                )}

                {referral.openemrPatientId && (
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">OpenEMR Patient ID</p>
                    <p className="text-sm font-mono" data-testid="text-openemr-patient-id">
                      {referral.openemrPatientId}
                    </p>
                  </div>
                )}

                <Separator />

                <Button
                  className="w-full"
                  onClick={() => syncToOpenEMRMutation.mutate()}
                  disabled={syncToOpenEMRMutation.isPending}
                  data-testid="button-sync-to-openemr"
                >
                  {syncToOpenEMRMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      {referral.syncStatus === "synced" ? "Re-sync to OpenEMR" : "Sync to OpenEMR"}
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

          </div>
        </div>
      </main>
    </div>
  );
}
