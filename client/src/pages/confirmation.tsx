import { useRoute, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, ClipboardCheck, FileText, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Encounter } from "@shared/schema";

export default function Confirmation() {
  const [, params] = useRoute("/confirmation/:referenceNumber");
  const referenceNumber = params?.referenceNumber;

  // Fetch the encounter to get the patient ID
  const { data: encounter, isLoading, isError } = useQuery<Encounter>({
    queryKey: [`/api/encounters/${referenceNumber}`],
    enabled: !!referenceNumber,
  });

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardContent className="pt-8 pb-8">
          <div className="flex flex-col items-center text-center space-y-6">
            <div className="relative">
              <div className="absolute inset-0 bg-primary/10 rounded-full blur-xl" />
              <CheckCircle className="relative h-20 w-20 text-primary" />
            </div>

            <div className="space-y-2">
              <h1 className="text-2xl font-medium text-foreground">Referral Submitted Successfully</h1>
              <p className="text-muted-foreground">
                Your patient referral has been submitted and is being processed.
              </p>
            </div>

            <div className="w-full bg-muted p-6 rounded-md space-y-3">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <ClipboardCheck className="h-4 w-4" />
                <span>Reference Number</span>
              </div>
              <p className="text-2xl font-mono font-medium text-foreground text-center" data-testid="text-reference-number">
                {referenceNumber}
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Save this reference number for your records
              </p>
            </div>

            <div className="w-full pt-4 space-y-3">
              {isLoading ? (
                <Button variant="default" className="w-full" disabled>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading...
                </Button>
              ) : encounter ? (
                <Link href={`/patients/${encounter.patientId}`} className="block">
                  <Button variant="default" className="w-full" data-testid="button-view-patient">
                    <FileText className="h-4 w-4 mr-2" />
                    View Patient Profile
                  </Button>
                </Link>
              ) : isError ? (
                <Link href="/patients" className="block">
                  <Button variant="default" className="w-full" data-testid="button-view-patients-error">
                    <FileText className="h-4 w-4 mr-2" />
                    Go to Patient List
                  </Button>
                </Link>
              ) : null}
              <Link href="/patients" className="block">
                <Button variant="outline" className="w-full" data-testid="button-back-to-list">
                  Back to Patient List
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
