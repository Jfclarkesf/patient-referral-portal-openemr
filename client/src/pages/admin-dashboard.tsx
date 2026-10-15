import React from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { Patient, Encounter, SystemSettings } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Lock, Users, FileText, Download, Shield, Trash2, Mail, UserPlus, UserCog } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const settingsFormSchema = z.object({
  notificationEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
});

const adminFormSchema = z.object({
  email: z.string().email("Valid email is required"),
});

type SettingsFormData = z.infer<typeof settingsFormSchema>;
type AdminFormData = z.infer<typeof adminFormSchema>;

export default function AdminDashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  
  const { data: patients, isLoading: patientsLoading } = useQuery<Patient[]>({
    queryKey: ["/api/patients"],
    refetchOnMount: 'always',
  });

  const { data: encounters, isLoading: encountersLoading } = useQuery<Encounter[]>({
    queryKey: ["/api/encounters"],
    refetchOnMount: 'always',
  });

  const { data: settings } = useQuery<SystemSettings>({
    queryKey: ["/api/settings"],
  });

  const settingsForm = useForm<SettingsFormData>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      notificationEmail: "",
    },
  });

  const adminForm = useForm<AdminFormData>({
    resolver: zodResolver(adminFormSchema),
    defaultValues: {
      email: "",
    },
  });

  // Update form when settings load
  React.useEffect(() => {
    if (settings) {
      settingsForm.reset({
        notificationEmail: settings.notificationEmail || "",
      });
    }
  }, [settings, settingsForm]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: SettingsFormData) => {
      const response = await apiRequest("PATCH", "/api/settings", {
        notificationEmail: data.notificationEmail || null,
      });
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Settings Updated",
        description: "Email notification settings have been updated.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update settings",
        variant: "destructive",
      });
    },
  });

  const makeAdminMutation = useMutation({
    mutationFn: async (data: AdminFormData) => {
      const response = await apiRequest("POST", "/api/admin/users", {
        email: data.email,
      });
      return await response.json();
    },
    onSuccess: (data) => {
      adminForm.reset();
      toast({
        title: "Admin Created",
        description: `${data.user.email} has been made an administrator.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to make user admin",
        variant: "destructive",
      });
    },
  });

  const pullMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/openemr/pull-encounters", {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const errorData = await response.text().catch(() => null);
        let errorMessage = "Failed to pull encounters from OpenEMR";
        try {
          const parsed = JSON.parse(errorData || "{}");
          errorMessage = parsed.error || errorMessage;
        } catch {
          errorMessage = errorData || errorMessage;
        }
        throw new Error(errorMessage);
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/patients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/encounters"] });
      
      toast({
        title: "Sync Successful",
        description: `Imported ${data.patientsCreated || 0} patients and ${data.encountersCreated || 0} encounters from OpenEMR`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/openemr/reconcile-encounters", {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const errorData = await response.text().catch(() => null);
        let errorMessage = "Failed to reconcile encounters";
        try {
          const parsed = JSON.parse(errorData || "{}");
          errorMessage = parsed.error || parsed.message || errorMessage;
        } catch {
          errorMessage = errorData || errorMessage;
        }
        throw new Error(errorMessage);
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/patients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/encounters"] });
      
      const encounterCount = data.deletedCount || 0;
      const patientCount = data.deletedPatientCount || 0;
      
      toast({
        title: "Cleanup Successful",
        description: `Deleted ${encounterCount} encounter(s) and ${patientCount} orphaned patient(s)`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cleanup Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isLoading = patientsLoading || encountersLoading;

  if (!user?.isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center">
            <Lock className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-medium text-foreground mb-2">Admin Only</h2>
            <p className="text-muted-foreground mb-6">
              You don't have permission to access this page. Only administrators can view this dashboard.
            </p>
            <Link href="/">
              <Button variant="outline" className="w-full">Back to Patients</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const syncedEncounters = encounters?.filter(e => e.syncStatus === "synced").length || 0;
  const importedEncounters = encounters?.filter(e => e.userId === "SYSTEM_IMPORT").length || 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="h-8 w-8 text-primary" />
              <div>
                <h1 className="text-3xl font-medium text-foreground">Admin Dashboard</h1>
                <p className="text-sm text-muted-foreground mt-1">System administration and OpenEMR sync</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Link href="/admin/users">
                <Button variant="outline" data-testid="link-user-management">
                  <UserCog className="h-4 w-4 mr-2" />
                  Manage Users
                </Button>
              </Link>
              <Link href="/">
                <Button variant="outline">
                  View Patients
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Patients</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-10 w-20" />
              ) : (
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  <span className="text-3xl font-bold" data-testid="text-total-patients">
                    {patients?.length || 0}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Encounters</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-10 w-20" />
              ) : (
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <span className="text-3xl font-bold" data-testid="text-total-encounters">
                    {encounters?.length || 0}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Imported from OpenEMR</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-10 w-20" />
              ) : (
                <div className="flex items-center gap-2">
                  <Download className="h-5 w-5 text-primary" />
                  <span className="text-3xl font-bold" data-testid="text-imported-encounters">
                    {importedEncounters}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email Notifications
            </CardTitle>
            <CardDescription>
              Configure email notifications for new referral submissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...settingsForm}>
              <form onSubmit={settingsForm.handleSubmit((data) => updateSettingsMutation.mutate(data))} className="space-y-4">
                <FormField
                  control={settingsForm.control}
                  name="notificationEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notification Email Address</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="email"
                          placeholder="admin@example.com"
                          data-testid="input-notification-email"
                        />
                      </FormControl>
                      <FormDescription>
                        Email address where referral notifications will be sent. Leave empty to disable notifications.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={updateSettingsMutation.isPending}
                  data-testid="button-save-email-settings"
                >
                  {updateSettingsMutation.isPending ? "Saving..." : "Save Email Settings"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Add Administrator
            </CardTitle>
            <CardDescription>
              Grant administrator privileges to another user by email
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...adminForm}>
              <form onSubmit={adminForm.handleSubmit((data) => makeAdminMutation.mutate(data))} className="space-y-4">
                <FormField
                  control={adminForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="email"
                          placeholder="user@example.com"
                          data-testid="input-admin-email"
                        />
                      </FormControl>
                      <FormDescription>
                        Enter the email address of the user you want to make an administrator. The user must have logged in at least once.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={makeAdminMutation.isPending}
                  data-testid="button-make-admin"
                >
                  {makeAdminMutation.isPending ? "Adding..." : "Make Administrator"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>OpenEMR Integration</CardTitle>
            <CardDescription>
              Manage the connection and synchronization with your OpenEMR system
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <h3 className="font-medium">OpenEMR Setup</h3>
                <p className="text-sm text-muted-foreground">
                  Register this app with OpenEMR, or change the OpenEMR address
                </p>
              </div>
              <Button variant="outline" asChild data-testid="button-openemr-setup">
                <Link href="/setup">Open Setup</Link>
              </Button>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <h3 className="font-medium">Connect to OpenEMR</h3>
                <p className="text-sm text-muted-foreground">
                  Authorize access to fetch encounters and patient data from OpenEMR
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => window.location.href = '/api/oauth/authorize'}
                data-testid="button-connect-openemr-admin"
              >
                Connect OpenEMR
              </Button>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <h3 className="font-medium">Pull Encounters from OpenEMR</h3>
                <p className="text-sm text-muted-foreground">
                  Import the latest encounters created in OpenEMR into this system
                </p>
              </div>
              <Button
                onClick={() => pullMutation.mutate()}
                disabled={pullMutation.isPending}
                data-testid="button-pull-encounters-admin"
              >
                <Download className="h-4 w-4 mr-2" />
                {pullMutation.isPending ? "Pulling..." : "Pull Encounters"}
              </Button>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <h3 className="font-medium">Clean Up Test Data</h3>
                <p className="text-sm text-muted-foreground">
                  Delete unsynced encounters and orphaned patients (patients with no encounters)
                </p>
              </div>
              <Button
                onClick={() => reconcileMutation.mutate()}
                disabled={reconcileMutation.isPending}
                variant="destructive"
                data-testid="button-reconcile-encounters-admin"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {reconcileMutation.isPending ? "Cleaning..." : "Clean Up"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
