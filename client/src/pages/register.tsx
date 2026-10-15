import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Activity, CheckCircle2, Loader2 } from "lucide-react";
import { isValidNpi, registerDoctorSchema } from "@shared/schema";

type RegisterFormValues = z.input<typeof registerDoctorSchema>;

type Step = "npi" | "details" | "done";

interface NpiLookup {
  firstName: string;
  lastName: string;
  credential: string;
  specialty: string;
  practiceName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  fax: string;
}

const emptyValues: RegisterFormValues = {
  npi: "",
  firstName: "",
  lastName: "",
  credential: "",
  specialty: "",
  practiceName: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
  fax: "",
  email: "",
  password: "",
  confirmPassword: "",
};

function TextField({
  control,
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  description,
  disabled,
  className,
}: {
  control: Control<RegisterFormValues>;
  name: keyof RegisterFormValues;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
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

export default function Register() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState<Step>("npi");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerDoctorSchema),
    defaultValues: emptyValues,
  });

  const handleLookup = async () => {
    const npi = (form.getValues("npi") || "").trim();
    setLookupError(null);

    if (!isValidNpi(npi)) {
      form.setError("npi", { message: "Enter your 10-digit individual NPI" });
      return;
    }

    setLookupLoading(true);
    try {
      const response = await fetch(`/api/register/npi/${npi}`);
      const result = await response.json();

      if (response.status === 503) {
        // Registry down: let them fill it in by hand
        setPrefilled(false);
        setLookupError(result.message);
        setStep("details");
        return;
      }

      if (!response.ok) {
        setLookupError(result.message || "That NPI couldn't be verified.");
        return;
      }

      const registry = result as NpiLookup;
      form.reset({
        ...form.getValues(),
        npi,
        firstName: registry.firstName,
        lastName: registry.lastName,
        credential: registry.credential,
        specialty: registry.specialty,
        practiceName: registry.practiceName,
        street: registry.street,
        city: registry.city,
        state: registry.state,
        zip: registry.zip,
        phone: registry.phone,
        fax: registry.fax,
      });
      setPrefilled(true);
      setStep("details");
    } catch {
      setLookupError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLookupLoading(false);
    }
  };

  const onSubmit = async (values: RegisterFormValues) => {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json();

      if (!response.ok) {
        if (result.errors) {
          for (const [field, messages] of Object.entries(result.errors as Record<string, string[]>)) {
            form.setError(field as keyof RegisterFormValues, { message: messages?.[0] });
          }
        }
        setSubmitError(result.message || "Registration failed.");
        return;
      }

      setStep("done");
    } catch {
      setSubmitError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const startOver = () => {
    form.reset(emptyValues);
    setPrefilled(false);
    setLookupError(null);
    setSubmitError(null);
    setStep("npi");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className={step === "details" ? "w-full max-w-2xl" : "w-full max-w-md"}>
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-primary/10 rounded-full">
              {step === "done" ? (
                <CheckCircle2 className="h-10 w-10 text-primary" />
              ) : (
                <Activity className="h-10 w-10 text-primary" />
              )}
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">
            {step === "done" ? "Account created" : "Create a referring provider account"}
          </CardTitle>
          <CardDescription className="text-base">
            {step === "npi" && "Start with your NPI. We'll fill in your details from the national registry."}
            {step === "details" && "Check your details, then choose how you'll sign in."}
            {step === "done" &&
              "Our staff will review your account, usually within one business day. Then sign in with your email and password."}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {step === "done" ? (
            <Button className="w-full" size="lg" onClick={() => setLocation("/login")} data-testid="button-go-login">
              Go to sign in
            </Button>
          ) : (
            <Form {...form}>
              <form
                onSubmit={
                  step === "npi"
                    ? (e) => {
                        e.preventDefault();
                        handleLookup();
                      }
                    : form.handleSubmit(onSubmit)
                }
                className="space-y-6"
              >
                {step === "npi" && (
                  <>
                    <TextField
                      control={form.control}
                      name="npi"
                      label="NPI"
                      placeholder="10 digits"
                      autoComplete="off"
                      disabled={lookupLoading}
                      description="Your individual (Type 1) NPI, not your group's."
                    />
                    {lookupError && (
                      <Alert variant="destructive">
                        <AlertDescription>{lookupError}</AlertDescription>
                      </Alert>
                    )}
                    <Button type="submit" className="w-full" size="lg" disabled={lookupLoading} data-testid="button-lookup-npi">
                      {lookupLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Looking up NPI...
                        </>
                      ) : (
                        "Look up NPI"
                      )}
                    </Button>
                  </>
                )}

                {step === "details" && (
                  <>
                    {prefilled ? (
                      <Alert>
                        <AlertDescription>
                          Filled in from the NPI registry. Update anything that's out of date, like your office phone or fax.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      lookupError && (
                        <Alert>
                          <AlertDescription>{lookupError}</AlertDescription>
                        </Alert>
                      )
                    )}

                    <section className="space-y-4">
                      <h2 className="text-sm font-semibold text-muted-foreground">Provider</h2>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <TextField control={form.control} name="npi" label="NPI" disabled />
                        <TextField control={form.control} name="credential" label="Credential" placeholder="MD, DO, NP, PA" />
                        <TextField control={form.control} name="firstName" label="First name" autoComplete="given-name" />
                        <TextField control={form.control} name="lastName" label="Last name" autoComplete="family-name" />
                        <TextField control={form.control} name="specialty" label="Specialty" className="sm:col-span-2" />
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h2 className="text-sm font-semibold text-muted-foreground">Practice</h2>
                      <div className="grid gap-4 sm:grid-cols-6">
                        <TextField
                          control={form.control}
                          name="practiceName"
                          label="Practice name"
                          autoComplete="organization"
                          className="sm:col-span-6"
                        />
                        <TextField
                          control={form.control}
                          name="street"
                          label="Street address"
                          autoComplete="street-address"
                          className="sm:col-span-6"
                        />
                        <TextField control={form.control} name="city" label="City" autoComplete="address-level2" className="sm:col-span-3" />
                        <TextField control={form.control} name="state" label="State" placeholder="CA" autoComplete="address-level1" className="sm:col-span-1" />
                        <TextField control={form.control} name="zip" label="ZIP" autoComplete="postal-code" className="sm:col-span-2" />
                        <TextField control={form.control} name="phone" label="Office phone" type="tel" autoComplete="tel" className="sm:col-span-3" />
                        <TextField
                          control={form.control}
                          name="fax"
                          label="Fax"
                          type="tel"
                          description="We send referral updates here."
                          className="sm:col-span-3"
                        />
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h2 className="text-sm font-semibold text-muted-foreground">Sign-in</h2>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <TextField
                          control={form.control}
                          name="email"
                          label="Email"
                          type="email"
                          autoComplete="email"
                          description="You'll use this to sign in."
                          className="sm:col-span-2"
                        />
                        <TextField control={form.control} name="password" label="Password" type="password" autoComplete="new-password" />
                        <TextField control={form.control} name="confirmPassword" label="Confirm password" type="password" autoComplete="new-password" />
                      </div>
                    </section>

                    {submitError && (
                      <Alert variant="destructive">
                        <AlertDescription>{submitError}</AlertDescription>
                      </Alert>
                    )}

                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                      <Button type="button" variant="ghost" onClick={startOver} disabled={isSubmitting} data-testid="button-start-over">
                        Use a different NPI
                      </Button>
                      <Button type="submit" size="lg" disabled={isSubmitting} data-testid="button-register">
                        {isSubmitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Creating account...
                          </>
                        ) : (
                          "Create account"
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </form>
            </Form>
          )}

          {step !== "done" && (
            <p className="text-sm text-center text-muted-foreground mt-6">
              Already have an account?{" "}
              <Link href="/login" className="text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
