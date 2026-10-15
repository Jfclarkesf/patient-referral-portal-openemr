import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useForm, type Control, type FieldValues, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Activity, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { setupAdminSchema, setupOpenEMRSchema } from "@shared/schema";
import { useAuth } from "@/contexts/AuthContext";

type AdminFormValues = z.input<typeof setupAdminSchema>;
type OpenEMRFormValues = z.input<typeof setupOpenEMRSchema>;

type Step = "admin" | "openemr" | "enable" | "done";

export interface SetupStatus {
  needsAdmin: boolean;
  suggestedAppUrl?: string;
  openemr?: {
    configured: boolean;
    source: "wizard" | "environment" | null;
    baseUrl: string | null;
    appUrl: string | null;
    clientName: string | null;
    clientId: string | null;
    redirectUri: string | null;
    connected: boolean;
  };
}

// Same fixed paths the server uses (server/openemr/client.ts)
const REGISTRATION_PATH = "/oauth2/default/registration";
const CALLBACK_PATH = "/api/oauth/callback";

const STEPS: { key: Step; label: string }[] = [
  { key: "admin", label: "Admin account" },
  { key: "openemr", label: "Register with OpenEMR" },
  { key: "enable", label: "Enable and connect" },
];

function TextField<T extends FieldValues>({
  control,
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  description,
  disabled,
}: {
  control: Control<T>;
  name: Path<T>;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              autoComplete={autoComplete}
              placeholder={placeholder}
              disabled={disabled}
              data-testid={`input-${name}`}
              {...field}
              value={field.value ?? ""}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function trimUrl(url: string | undefined): string {
  return (url || "").trim().replace(/\/+$/, "");
}

export default function Setup() {
  const [, setLocation] = useLocation();
  const { refetch: refetchAuth } = useAuth();
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [registered, setRegistered] = useState<{ clientId: string; redirectUri: string; clientsPageUrl: string } | null>(null);

  const { data: status, refetch: refetchStatus, isError } = useQuery<SetupStatus>({
    queryKey: ["/api/setup/status"],
    staleTime: 0,
  });

  const adminForm = useForm<AdminFormValues>({
    resolver: zodResolver(setupAdminSchema),
    defaultValues: { firstName: "", lastName: "", email: "", username: "", password: "", confirmPassword: "" },
  });

  const openemrForm = useForm<OpenEMRFormValues>({
    resolver: zodResolver(setupOpenEMRSchema),
    defaultValues: { openemrUrl: "", appUrl: "", clientName: "Patient Referral System" },
  });

  // Pick the step from what the server says is still missing
  useEffect(() => {
    if (!status) return;
    if (status.needsAdmin) {
      setStep("admin");
      return;
    }
    if (!status.openemr) {
      // Setup is done and this visitor isn't an admin
      setLocation("/login");
      return;
    }
    if (step === null || step === "admin") {
      const o = status.openemr;
      setStep(!o.configured ? "openemr" : o.connected ? "done" : "enable");
    }
    if (!openemrForm.getValues("appUrl")) {
      openemrForm.setValue("appUrl", status.openemr.appUrl || status.suggestedAppUrl || "");
      if (status.openemr.baseUrl) openemrForm.setValue("openemrUrl", status.openemr.baseUrl);
      if (status.openemr.clientName) openemrForm.setValue("clientName", status.openemr.clientName);
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const postJson = async (url: string, body: unknown, form: { setError: (name: any, e: { message: string }) => void }) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      for (const [field, messages] of Object.entries(result.errors || {})) {
        form.setError(field, { message: (messages as string[])[0] });
      }
      throw new Error(result.message || "Something went wrong. Try again.");
    }
    return result;
  };

  const onCreateAdmin = async (values: AdminFormValues) => {
    setError(null);
    setIsSubmitting(true);
    try {
      await postJson("/api/setup/admin", values, adminForm);
      await refetchAuth();
      setStep("openemr");
      await refetchStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const onRegister = async (values: OpenEMRFormValues) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await postJson("/api/setup/openemr", values, openemrForm);
      setRegistered(result);
      setStep("enable");
      await refetchStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openemrUrl = trimUrl(openemrForm.watch("openemrUrl"));
  const appUrl = trimUrl(openemrForm.watch("appUrl"));
  const clientName = registered ? openemrForm.getValues("clientName") : status?.openemr?.clientName || openemrForm.getValues("clientName");
  const clientsPageUrl = registered?.clientsPageUrl || (status?.openemr?.baseUrl ? `${status.openemr.baseUrl}/interface/smart/admin-client.php` : null);
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-xl">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-primary/10 rounded-full">
              <Activity className="h-10 w-10 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">Set up the Patient Referral System</CardTitle>
          <CardDescription className="text-base">
            {step === "done" ? "Everything is connected." : "A few steps to get this installation ready."}
          </CardDescription>
          {step && step !== "done" && (
            <ol className="flex justify-center gap-2 pt-4 text-xs" data-testid="setup-steps">
              {STEPS.map((s, i) => (
                <li
                  key={s.key}
                  className={`rounded-full px-3 py-1 ${
                    i === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : i < stepIndex
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i + 1}. {s.label}
                </li>
              ))}
            </ol>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription data-testid="text-setup-error">{error}</AlertDescription>
            </Alert>
          )}

          {isError && (
            <Alert variant="destructive">
              <AlertDescription>Can't reach the server. Check that it's running, then reload this page.</AlertDescription>
            </Alert>
          )}

          {!step && !isError && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {step === "admin" && (
            <Form {...adminForm}>
              <form onSubmit={adminForm.handleSubmit(onCreateAdmin)} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Create the administrator account. It manages users and the OpenEMR connection.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField control={adminForm.control} name="firstName" label="First name" autoComplete="given-name" disabled={isSubmitting} />
                  <TextField control={adminForm.control} name="lastName" label="Last name" autoComplete="family-name" disabled={isSubmitting} />
                </div>
                <TextField
                  control={adminForm.control}
                  name="email"
                  label="Email"
                  type="email"
                  autoComplete="email"
                  description="New referral notifications go here. You can change it later."
                  disabled={isSubmitting}
                />
                <TextField control={adminForm.control} name="username" label="Username" autoComplete="username" disabled={isSubmitting} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField control={adminForm.control} name="password" label="Password" type="password" autoComplete="new-password" disabled={isSubmitting} />
                  <TextField control={adminForm.control} name="confirmPassword" label="Confirm password" type="password" autoComplete="new-password" disabled={isSubmitting} />
                </div>
                <Button type="submit" className="w-full" size="lg" disabled={isSubmitting} data-testid="button-create-admin">
                  {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating account...</> : "Create admin account"}
                </Button>
              </form>
            </Form>
          )}

          {step === "openemr" && (
            <Form {...openemrForm}>
              <form onSubmit={openemrForm.handleSubmit(onRegister)} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Register this app as an API client in your OpenEMR. OpenEMR returns a client ID and secret,
                  which are saved here. Nothing needs to go in a <code>.env</code> file.
                </p>
                <TextField
                  control={openemrForm.control}
                  name="openemrUrl"
                  label="OpenEMR address"
                  placeholder="https://openemr.example.com"
                  description="The address you open OpenEMR at, without /interface or /login."
                  disabled={isSubmitting}
                />
                <TextField
                  control={openemrForm.control}
                  name="appUrl"
                  label="This app's address"
                  placeholder="https://referrals.example.com"
                  description="The public address of this app. OpenEMR sends you back here after you sign in."
                  disabled={isSubmitting}
                />
                <TextField
                  control={openemrForm.control}
                  name="clientName"
                  label="Application name"
                  description="How this app shows up in OpenEMR's list of API clients."
                  disabled={isSubmitting}
                />

                <div className="rounded-md bg-muted p-3 text-xs space-y-1 break-all" data-testid="text-registration-preview">
                  <div>
                    <span className="text-muted-foreground">Registers at: </span>
                    {openemrUrl ? `${openemrUrl}${REGISTRATION_PATH}` : `…${REGISTRATION_PATH}`}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Redirect URI: </span>
                    {appUrl ? `${appUrl}${CALLBACK_PATH}` : `…${CALLBACK_PATH}`}
                  </div>
                </div>

                {status?.openemr?.source === "environment" && (
                  <Alert>
                    <AlertDescription>
                      This install already uses a client from the <code>OPENEMR_*</code> environment variables.
                      Registering here replaces it.
                    </AlertDescription>
                  </Alert>
                )}

                <Button type="submit" className="w-full" size="lg" disabled={isSubmitting} data-testid="button-register-openemr">
                  {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Registering...</> : "Register with OpenEMR"}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => setLocation("/")} data-testid="button-skip-openemr">
                  Skip for now
                </Button>
              </form>
            </Form>
          )}

          {step === "enable" && (
            <div className="space-y-4">
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>
                  Registered as <strong>{clientName}</strong>
                  {(registered?.clientId || status?.openemr?.clientId) && (
                    <> (client ID <code className="break-all">{registered?.clientId || status?.openemr?.clientId}</code>)</>
                  )}.
                </AlertDescription>
              </Alert>
              <div className="text-sm space-y-2">
                <p className="font-medium">OpenEMR adds new API clients switched off. Turn this one on:</p>
                <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                  <li>In OpenEMR, go to <strong>Admin &gt; System &gt; API Clients</strong>.</li>
                  <li>Find <strong>{clientName}</strong> and click <strong>Edit</strong>.</li>
                  <li>Click <strong>Enable Client</strong>.</li>
                </ol>
                {clientsPageUrl && (
                  <a
                    href={clientsPageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    data-testid="link-openemr-clients"
                  >
                    Open API Clients in OpenEMR <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Then connect. You'll sign in to OpenEMR and approve the access this app asks for.
              </p>
              <Button
                className="w-full"
                size="lg"
                onClick={() => { window.location.href = "/api/oauth/authorize"; }}
                data-testid="button-connect-openemr"
              >
                Connect to OpenEMR
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => setStep("openemr")} data-testid="button-change-openemr">
                  Change details
                </Button>
                <Button variant="ghost" className="flex-1" onClick={() => setLocation("/")} data-testid="button-finish-later">
                  Finish later
                </Button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
              <p className="text-sm text-muted-foreground">
                Connected to OpenEMR at <strong className="break-all">{status?.openemr?.baseUrl}</strong>.
              </p>
              <Button className="w-full" size="lg" onClick={() => setLocation("/")} data-testid="button-setup-done">
                Go to the app
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setStep("openemr")} data-testid="button-reregister">
                Register a new OpenEMR client
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
