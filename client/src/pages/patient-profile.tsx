import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Calendar, Mail, Phone, User, Plus, FileText, Activity, UserCheck } from "lucide-react";
import type { Patient, Encounter } from "@shared/schema";

interface PatientProfileProps {
  id: string;
}

export default function PatientProfile({ id }: PatientProfileProps) {
  const [, setLocation] = useLocation();

  const { data: patient, isLoading: patientLoading } = useQuery<Patient>({
    queryKey: ["/api/patients", id],
  });

  const { data: encounters, isLoading: encountersLoading } = useQuery<Encounter[]>({
    queryKey: ["/api/patients", id, "encounters"],
  });

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const formatDateTime = (date: string | Date) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

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

  if (patientLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading patient...</p>
        </div>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Card>
          <CardContent className="py-12 text-center">
            <h3 className="text-lg font-semibold mb-2">Patient not found</h3>
            <p className="text-muted-foreground mb-4">
              The patient you're looking for doesn't exist
            </p>
            <Button asChild data-testid="button-back-to-patients">
              <Link href="/patients">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Patients
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => setLocation("/patients")}
        data-testid="button-back"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Patients
      </Button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Patient Information</CardTitle>
              <CardDescription>Demographics and contact details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="text-2xl font-bold mb-1" data-testid="text-patient-name">
                  {patient.firstName} {patient.lastName}
                </h3>
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  <span data-testid="text-patient-dob">
                    Born {formatDate(patient.dateOfBirth)}
                  </span>
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                {patient.gender && (
                  <div className="flex items-start gap-3">
                    <User className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Gender</p>
                      <p className="text-sm text-muted-foreground capitalize" data-testid="text-patient-gender">
                        {patient.gender}
                      </p>
                    </div>
                  </div>
                )}

                {patient.email && (
                  <div className="flex items-start gap-3">
                    <Mail className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Email</p>
                      <p className="text-sm text-muted-foreground break-all" data-testid="text-patient-email">
                        {patient.email}
                      </p>
                    </div>
                  </div>
                )}

                {patient.phone && (
                  <div className="flex items-start gap-3">
                    <Phone className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Phone</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-patient-phone">
                        {patient.phone}
                      </p>
                    </div>
                  </div>
                )}

                {patient.primaryLanguage && (
                  <div className="flex items-start gap-3">
                    <Activity className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Primary Language</p>
                      <p className="text-sm text-muted-foreground" data-testid="text-patient-language">
                        {patient.primaryLanguage}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {patient.openemrPatientId && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-1">OpenEMR Patient ID</p>
                    <Badge variant="outline" data-testid="badge-openemr-id">
                      {patient.openemrPatientId}
                    </Badge>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold mb-1">Encounter History</h2>
              <p className="text-muted-foreground">
                {encounters?.length || 0} {encounters?.length === 1 ? "encounter" : "encounters"} on record
              </p>
            </div>
          </div>

          {encountersLoading ? (
            <Card>
              <CardContent className="py-12 text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
                <p className="text-muted-foreground">Loading encounters...</p>
              </CardContent>
            </Card>
          ) : !encounters || encounters.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileText className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-semibold mb-2">No encounters yet</h3>
                <p className="text-muted-foreground">
                  Encounters will appear here after being created in OpenEMR
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {encounters.map((encounter) => (
                <Link
                  key={encounter.id}
                  href={`/encounters/${encounter.referenceNumber}`}
                  data-testid={`link-encounter-${encounter.referenceNumber}`}
                >
                  <Card className="hover-elevate active-elevate-2 cursor-pointer">
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-lg" data-testid={`text-encounter-diagnosis-${encounter.referenceNumber}`}>
                            {encounter.diagnosis}
                          </CardTitle>
                          <CardDescription className="mt-1">
                            Ref: <span data-testid={`text-encounter-ref-${encounter.referenceNumber}`}>{encounter.referenceNumber}</span>
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={getUrgencyVariant(encounter.urgency)}
                            data-testid={`badge-urgency-${encounter.referenceNumber}`}
                          >
                            {encounter.urgency}
                          </Badge>
                          {encounter.userId === "SYSTEM_IMPORT" && encounter.openemrPractitioner && (
                            <Badge variant="secondary" data-testid={`badge-imported-${encounter.referenceNumber}`}>
                              Imported from OpenEMR
                            </Badge>
                          )}
                          {encounter.syncStatus === "synced" && (
                            <Badge variant="outline" data-testid={`badge-sync-status-${encounter.referenceNumber}`}>
                              Synced
                            </Badge>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Calendar className="h-4 w-4" />
                          <span data-testid={`text-encounter-date-${encounter.referenceNumber}`}>
                            {formatDateTime(encounter.submittedAt)}
                          </span>
                        </div>
                        {encounter.icd10Code && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <FileText className="h-4 w-4" />
                            <span data-testid={`text-encounter-icd10-${encounter.referenceNumber}`}>
                              ICD-10: {encounter.icd10Code}
                            </span>
                          </div>
                        )}
                        {encounter.openemrPractitioner && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <UserCheck className="h-4 w-4" />
                            <span data-testid={`text-encounter-practitioner-${encounter.referenceNumber}`}>
                              Provider: {encounter.openemrPractitioner}
                            </span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
