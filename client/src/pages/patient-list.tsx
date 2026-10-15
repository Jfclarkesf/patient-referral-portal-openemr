import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { User, Calendar, Mail, Phone, Plus, Download, RefreshCw } from "lucide-react";
import type { Patient, Encounter } from "@shared/schema";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

export default function PatientList() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  
  const { data: patients, isLoading } = useQuery<Patient[]>({
    queryKey: ["/api/patients"],
  });

  const { data: encounters } = useQuery<Encounter[]>({
    queryKey: ["/api/encounters"],
  });

  const pullEncountersMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/openemr/pull-encounters", {
        method: "POST",
        credentials: "include",
      });
      
      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch {
          // Fallback to text if JSON parsing fails
          const errorText = await response.text();
          throw new Error(errorText || `HTTP ${response.status}: Failed to pull encounters`);
        }
        
        // Show detailed error with list of failed encounters if available
        const errorMessage = errorData.message || errorData.error || "Failed to pull encounters";
        const errorDetails = errorData.errors?.length > 0 
          ? `\n\nDetails:\n${errorData.errors.slice(0, 3).join('\n')}${errorData.errors.length > 3 ? `\n...and ${errorData.errors.length - 3} more` : ''}`
          : '';
        
        throw new Error(errorMessage + errorDetails);
      }
      
      return await response.json() as {
        success: boolean;
        message: string;
        patientsCreated: number;
        encountersCreated: number;
        errors?: string[];
      };
    },
    onSuccess: (data) => {
      // Show warning if some encounters failed
      if (data.errors && data.errors.length > 0) {
        toast({
          title: "Sync Completed with Warnings",
          description: `${data.message}\n\n${data.errors.length} encounter(s) failed to import. Check the details for more information.`,
          variant: "default",
        });
      } else {
        toast({
          title: "Sync Complete",
          description: data.message,
        });
      }
      
      // Refresh patients and encounters lists
      queryClient.invalidateQueries({ queryKey: ["/api/patients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/encounters"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to pull encounters from OpenEMR",
        variant: "destructive",
      });
    },
  });

  const syncPatientMutation = useMutation({
    mutationFn: async (patientId: string) => {
      const response = await fetch(`/api/patients/${patientId}/sync-openemr`, {
        method: "POST",
        credentials: "include",
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error || "Failed to sync patient");
      }
      
      return await response.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.alreadySynced ? "Already Synced" : "Patient Synced",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/patients"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync patient to OpenEMR",
        variant: "destructive",
      });
    },
  });

  const getEncounterCount = (patientId: string) => {
    if (!encounters) return 0;
    return encounters.filter((e) => e.patientId === patientId).length;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading patients...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">
            Patients
          </h1>
          <p className="text-muted-foreground">
            Manage patient profiles and their encounter history
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setLocation("/new-referral")}
            data-testid="button-new-referral"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Referral
          </Button>
          {user?.isAdmin && (
            <Button
              variant="outline"
              onClick={() => pullEncountersMutation.mutate()}
              disabled={pullEncountersMutation.isPending}
              data-testid="button-pull-encounters"
            >
              <Download className="h-4 w-4 mr-2" />
              {pullEncountersMutation.isPending ? "Pulling..." : "Pull from OpenEMR"}
            </Button>
          )}
        </div>
      </div>

      {!patients || patients.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No patients yet</h3>
            <p className="text-muted-foreground">
              Patients will appear here after you pull encounters from OpenEMR
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {patients.map((patient) => (
            <Card 
              key={patient.id}
              className="hover-elevate active-elevate-2 cursor-pointer h-full"
              onClick={() => setLocation(`/patients/${patient.id}`)}
              data-testid={`card-patient-${patient.id}`}
            >
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-xl mb-1 truncate" data-testid={`text-patient-name-${patient.id}`}>
                      {patient.firstName} {patient.lastName}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      <span data-testid={`text-patient-dob-${patient.id}`}>
                        DOB: {formatDate(patient.dateOfBirth)}
                      </span>
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {!patient.openemrPatientId && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          syncPatientMutation.mutate(patient.id);
                        }}
                        disabled={syncPatientMutation.isPending}
                        title="Sync to OpenEMR"
                        data-testid={`button-sync-patient-${patient.id}`}
                      >
                        <RefreshCw className={`h-4 w-4 ${syncPatientMutation.isPending ? 'animate-spin' : ''}`} />
                      </Button>
                    )}
                    <Badge variant="secondary" data-testid={`badge-encounter-count-${patient.id}`}>
                      {getEncounterCount(patient.id)} {getEncounterCount(patient.id) === 1 ? "Encounter" : "Encounters"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {patient.email && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate" data-testid={`text-patient-email-${patient.id}`}>
                        {patient.email}
                      </span>
                    </div>
                  )}
                  {patient.phone && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-4 w-4 flex-shrink-0" />
                      <span data-testid={`text-patient-phone-${patient.id}`}>
                        {patient.phone}
                      </span>
                    </div>
                  )}
                  {patient.gender && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <User className="h-4 w-4 flex-shrink-0" />
                      <span className="capitalize" data-testid={`text-patient-gender-${patient.id}`}>
                        {patient.gender}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
