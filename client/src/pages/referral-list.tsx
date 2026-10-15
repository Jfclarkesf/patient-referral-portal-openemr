import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Referral } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, Plus, Calendar, User } from "lucide-react";
import { format } from "date-fns";

export default function ReferralList() {
  const { data: referrals, isLoading } = useQuery<Referral[]>({
    queryKey: ["/api/referrals"],
    refetchOnMount: 'always',
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

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ClipboardCheck className="h-8 w-8 text-primary" />
              <div>
                <h1 className="text-3xl font-medium text-foreground">Patient Referral System</h1>
                <p className="text-sm text-muted-foreground mt-1">Manage and track patient referrals</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/admin">
                <Button variant="outline" data-testid="button-admin-dashboard">
                  Admin Dashboard
                </Button>
              </Link>
              <Link href="/new-referral">
                <Button data-testid="button-new-referral">
                  <Plus className="h-4 w-4 mr-2" />
                  New Referral
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-medium text-foreground">All Referrals</h2>
          <p className="text-muted-foreground mt-1">View and manage submitted patient referrals</p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-32 mt-2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !referrals || referrals.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <ClipboardCheck className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-xl font-medium text-foreground mb-2">No Referrals Yet</h3>
              <p className="text-muted-foreground text-center mb-6 max-w-md">
                Get started by creating your first patient referral. All submitted referrals will appear here.
              </p>
              <Link href="/new-referral">
                <Button data-testid="button-create-first-referral">
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Referral
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {referrals.map((referral) => (
              <Card key={referral.id} className="hover-elevate">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-xl">
                        {referral.firstName} {referral.lastName}
                      </CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        <span className="font-mono text-sm">Ref: {referral.referenceNumber}</span>
                      </CardDescription>
                    </div>
                    <Badge variant={getUrgencyColor(referral.urgency)} data-testid={`badge-urgency-${referral.id}`}>
                      {referral.urgency.charAt(0).toUpperCase() + referral.urgency.slice(1)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div className="flex items-center gap-2 text-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">Diagnosis:</span>
                      <span className="text-foreground font-medium">{referral.diagnosis}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">Submitted:</span>
                      <span className="text-foreground font-medium">
                        {format(new Date(referral.submittedAt), "MMM d, yyyy")}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Link href={`/referrals/${referral.referenceNumber}`}>
                      <Button variant="outline" data-testid={`button-view-details-${referral.id}`}>
                        View Details
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
