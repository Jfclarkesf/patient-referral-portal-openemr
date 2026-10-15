import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { insertPatientSchema, insertEncounterSchema, isValidNpi, type Patient } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ClipboardCheck, User, FileText, Search, Plus, ArrowLeft, Paperclip } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { ICD10Search } from "@/components/icd10-search";
import { DocumentUpload, type PendingDocument } from "@/components/document-upload";

interface NewEncounterProps {
  patientId?: string;
}

// OpenEMR needs the patient's address to accept insurance (subscriber address)
const newPatientFormSchema = insertPatientSchema.extend({
  street: z.string().trim().min(2, "Street address is required"),
  city: z.string().trim().min(2, "City is required"),
  state: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => /^[A-Z]{2}$/.test(s), "Use the 2-letter state code"),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP is 5 digits (or ZIP+4)"),
});

const encounterFormSchema = z.object({
  diagnosis: z.string().min(1, "Diagnosis is required"),
  urgency: z.enum(["routine", "urgent", "emergency"]),
  medicalHistory: z.string().optional(),
  currentMedications: z.string().optional(),
  icd10Code: z.string().optional(),
  referralReason: z.string().optional(),
  insurancePlan: z.string().optional(),
  policyNumber: z.string().optional(),
  groupNumber: z.string().optional(),
  effectiveDate: z.string().optional(),
  insuranceEndDate: z.string().optional(),
  subscriberRelationship: z.enum(["self", "spouse", "child", "other"]),
  subscriberFirstName: z.string().optional(),
  subscriberLastName: z.string().optional(),
  subscriberDob: z.string().optional(),
  subscriberSex: z.enum(["male", "female", "other"]).optional(),
  subscriberSsn: z
    .string()
    .optional()
    .refine((s) => !s || s.replace(/\D/g, "").length === 9, "SSN is 9 digits"),
  sameAddressAsPatient: z.boolean(),
  subscriberStreet: z.string().optional(),
  subscriberCity: z.string().optional(),
  subscriberState: z.string().optional(),
  subscriberPostalCode: z.string().optional(),
  acceptAssignment: z.boolean(),
  referringProvider: z.string().min(1, "Referring provider is required"),
  providerContact: z.string().min(1, "Provider contact is required"),
  referringProviderNpi: z
    .string()
    .trim()
    .refine((s) => s === "" || isValidNpi(s), "Enter a valid 10-digit NPI")
    .optional(),
}).superRefine((d, ctx) => {
  // Insurance is optional, but once started OpenEMR needs all of these
  const hasInsurance = [d.insurancePlan, d.policyNumber, d.groupNumber, d.effectiveDate, d.insuranceEndDate]
    .some((v) => v?.trim());
  if (!hasInsurance) return;

  const need = (field: keyof typeof d, message: string) => {
    const value = d[field];
    if (typeof value !== "string" || value.trim().length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  };
  need("insurancePlan", "Insurance plan is required");
  need("policyNumber", "Policy number is required");
  need("effectiveDate", "Effective date is required");
  need("insuranceEndDate", "End date is required");
  if (d.effectiveDate && d.insuranceEndDate && d.insuranceEndDate < d.effectiveDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["insuranceEndDate"], message: "End date can't be before the effective date" });
  }
  if (d.subscriberRelationship !== "self") {
    need("subscriberFirstName", "Subscriber first name is required");
    need("subscriberLastName", "Subscriber last name is required");
    need("subscriberDob", "Subscriber date of birth is required");
    if (!d.subscriberSex) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriberSex"], message: "Subscriber sex is required" });
    }
  }
  if (!d.sameAddressAsPatient) {
    need("subscriberStreet", "Subscriber street is required");
    need("subscriberCity", "Subscriber city is required");
    if (!/^[A-Za-z]{2}$/.test(d.subscriberState?.trim() || "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriberState"], message: "Use the 2-letter state code" });
    }
    if (!/^\d{5}(-\d{4})?$/.test(d.subscriberPostalCode?.trim() || "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriberPostalCode"], message: "ZIP is 5 digits (or ZIP+4)" });
    }
  }
});

type EncounterFormData = z.infer<typeof encounterFormSchema>;

export default function NewEncounter({ patientId: initialPatientId }: NewEncounterProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<"select" | "new">(initialPatientId ? "select" : "select");
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>(initialPatientId);
  const [searchQuery, setSearchQuery] = useState("");
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const uploadingDocuments = documents.some((d) => d.status === "uploading");

  const { data: patients } = useQuery<Patient[]>({
    queryKey: ["/api/patients"],
  });

  const { data: selectedPatient } = useQuery<Patient>({
    queryKey: ["/api/patients", selectedPatientId],
    enabled: !!selectedPatientId && mode === "select",
  });

  const patientForm = useForm({
    resolver: zodResolver(newPatientFormSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      dateOfBirth: "",
      gender: "male" as const,
      email: "",
      phone: "",
      primaryLanguage: "",
      street: "",
      city: "",
      state: "",
      postalCode: "",
    },
  });

  const encounterForm = useForm<EncounterFormData>({
    resolver: zodResolver(encounterFormSchema),
    defaultValues: {
      diagnosis: "",
      urgency: "routine",
      medicalHistory: "",
      currentMedications: "",
      icd10Code: "",
      referralReason: "",
      insurancePlan: "",
      policyNumber: "",
      groupNumber: "",
      effectiveDate: "",
      insuranceEndDate: "",
      subscriberRelationship: "self",
      subscriberFirstName: "",
      subscriberLastName: "",
      subscriberDob: "",
      subscriberSex: undefined,
      subscriberSsn: "",
      sameAddressAsPatient: true,
      subscriberStreet: "",
      subscriberCity: "",
      subscriberState: "",
      subscriberPostalCode: "",
      acceptAssignment: true,
      referringProvider: "",
      providerContact: "",
      referringProviderNpi: "",
    },
  });

  const [npiLookupLoading, setNpiLookupLoading] = useState(false);

  // Fill the referring provider's name and phone from the national NPI registry
  const lookupReferringNpi = async () => {
    const npi = (encounterForm.getValues("referringProviderNpi") || "").trim();
    if (!isValidNpi(npi)) {
      encounterForm.setError("referringProviderNpi", { message: "Enter a valid 10-digit NPI" });
      return;
    }
    setNpiLookupLoading(true);
    try {
      const response = await fetch(`/api/npi/${npi}`, { credentials: "include" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        encounterForm.setError("referringProviderNpi", { message: result.message || "NPI lookup failed" });
        return;
      }
      encounterForm.clearErrors("referringProviderNpi");
      const name = [result.firstName, result.lastName].filter(Boolean).join(" ");
      encounterForm.setValue("referringProvider", result.credential ? `${name}, ${result.credential}` : name, { shouldValidate: true });
      if (result.phone) {
        encounterForm.setValue("providerContact", result.phone, { shouldValidate: true });
      }
    } catch {
      encounterForm.setError("referringProviderNpi", { message: "NPI lookup failed. Enter the details by hand." });
    } finally {
      setNpiLookupLoading(false);
    }
  };

  const subscriberRelationship = encounterForm.watch("subscriberRelationship");
  const sameAddressAsPatient = encounterForm.watch("sameAddressAsPatient");

  const createPatientMutation = useMutation({
    mutationFn: async (data: z.infer<typeof newPatientFormSchema>) => {
      const response = await apiRequest("POST", "/api/patients", data);
      return await response.json();
    },
  });

  const createEncounterMutation = useMutation({
    mutationFn: async ({ patientId, encounterData }: { patientId: string; encounterData: Omit<EncounterFormData, "sameAddressAsPatient"> }) => {
      const response = await apiRequest("POST", "/api/encounters", {
        ...encounterData,
        patientId,
        documentIds: documents.filter((d) => d.status === "uploaded" && d.id).map((d) => d.id),
      });
      return await response.json();
    },
    onSuccess: async (data: { referenceNumber: string; patientId: string }) => {
      // Invalidate all encounter and patient queries to refresh data
      await queryClient.invalidateQueries({ queryKey: ["/api/encounters"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/patients"] });
      // Also invalidate patient-specific encounter queries
      await queryClient.invalidateQueries({ queryKey: [`/api/patients/${data.patientId}/encounters`] });
      toast({
        title: "Encounter Created",
        description: `Reference number: ${data.referenceNumber}`,
      });
      setLocation(`/confirmation/${data.referenceNumber}`);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create encounter. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = async (encounterData: EncounterFormData) => {
    if (uploadingDocuments) {
      toast({
        title: "Files still uploading",
        description: "Wait for the documents to finish uploading, then submit.",
        variant: "destructive",
      });
      return;
    }

    let patientId = selectedPatientId;

    if (mode === "new") {
      const patientData = patientForm.getValues();
      const valid = await patientForm.trigger();
      
      if (!valid) {
        toast({
          title: "Validation Error",
          description: "Please fill in all required patient fields",
          variant: "destructive",
        });
        return;
      }

      try {
        const newPatient = await createPatientMutation.mutateAsync(patientData);
        patientId = newPatient.id;
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to create patient. Please try again.",
          variant: "destructive",
        });
        return;
      }
    }

    if (!patientId) {
      toast({
        title: "Patient Required",
        description: "Please select or create a patient first",
        variant: "destructive",
      });
      return;
    }

    const hasInsurance = !!(encounterData.insurancePlan?.trim() || encounterData.policyNumber?.trim());
    if (hasInsurance && encounterData.sameAddressAsPatient && mode === "select" && selectedPatient && !selectedPatient.street) {
      encounterForm.setValue("sameAddressAsPatient", false);
      toast({
        title: "Address needed",
        description: "This patient has no address on file. Enter the subscriber address for the insurance.",
        variant: "destructive",
      });
      return;
    }

    const { sameAddressAsPatient, ...rest } = encounterData;
    const payload = sameAddressAsPatient
      ? { ...rest, subscriberStreet: "", subscriberCity: "", subscriberState: "", subscriberPostalCode: "" }
      : rest;

    createEncounterMutation.mutate({ patientId, encounterData: payload });
  };

  const filteredPatients = patients?.filter(p => 
    searchQuery === "" ||
    `${p.firstName} ${p.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => setLocation("/")}
        data-testid="button-back"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back
      </Button>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Create New Encounter</h1>
        <p className="text-muted-foreground">
          Select an existing patient or create a new one, then enter encounter details
        </p>
      </div>

      <div className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Step 1: Patient Selection
            </CardTitle>
            <CardDescription>
              Choose to select an existing patient or create a new one
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as "select" | "new")}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="select" id="select" data-testid="radio-select-patient" />
                <Label htmlFor="select">Select existing patient</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="new" id="new" data-testid="radio-new-patient" />
                <Label htmlFor="new">Create new patient</Label>
              </div>
            </RadioGroup>

            <Separator />

            {mode === "select" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="search">Search Patients</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="search"
                        placeholder="Search by name or email..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9"
                        data-testid="input-search-patients"
                      />
                    </div>
                  </div>
                </div>

                {filteredPatients && filteredPatients.length > 0 ? (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {filteredPatients.map((patient) => (
                      <Card
                        key={patient.id}
                        className={`cursor-pointer hover-elevate active-elevate-2 ${
                          selectedPatientId === patient.id ? "ring-2 ring-primary" : ""
                        }`}
                        onClick={() => setSelectedPatientId(patient.id)}
                        data-testid={`card-patient-${patient.id}`}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h4 className="font-semibold">
                                {patient.firstName} {patient.lastName}
                              </h4>
                              <p className="text-sm text-muted-foreground">
                                DOB: {new Date(patient.dateOfBirth).toLocaleDateString()}
                              </p>
                              {patient.email && (
                                <p className="text-sm text-muted-foreground">{patient.email}</p>
                              )}
                            </div>
                            {selectedPatientId === patient.id && (
                              <Badge>Selected</Badge>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-muted-foreground py-8">
                    {searchQuery ? "No patients found matching your search" : "No patients in database"}
                  </p>
                )}
              </div>
            )}

            {mode === "new" && (
              <Form {...patientForm}>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={patientForm.control}
                      name="firstName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>First Name *</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-first-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={patientForm.control}
                      name="lastName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Last Name *</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-last-name" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={patientForm.control}
                      name="dateOfBirth"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Date of Birth *</FormLabel>
                          <FormControl>
                            <Input type="date" {...field} data-testid="input-dob" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={patientForm.control}
                      name="gender"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gender *</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-gender">
                                <SelectValue placeholder="Select gender" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="male">Male</SelectItem>
                              <SelectItem value="female">Female</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={patientForm.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl>
                            <Input type="email" {...field} value={field.value || ""} data-testid="input-email" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={patientForm.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Phone</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} data-testid="input-phone" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={patientForm.control}
                    name="primaryLanguage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Primary Language</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} data-testid="input-language" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={patientForm.control}
                    name="street"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Street Address *</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} data-testid="input-street" />
                        </FormControl>
                        <FormDescription>
                          Needed for OpenEMR to accept the patient's insurance
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] gap-4">
                    <FormField
                      control={patientForm.control}
                      name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>City *</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} data-testid="input-city" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={patientForm.control}
                      name="state"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>State *</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} maxLength={2} placeholder="CA" data-testid="input-state" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={patientForm.control}
                      name="postalCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>ZIP *</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} inputMode="numeric" data-testid="input-postal-code" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              </Form>
            )}
          </CardContent>
        </Card>

        {(selectedPatientId || mode === "new") && (
          <Form {...encounterForm}>
            <form onSubmit={encounterForm.handleSubmit(handleSubmit)} className="space-y-8">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Step 2: Encounter Details
                  </CardTitle>
                  <CardDescription>
                    Enter the medical information for this encounter
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={encounterForm.control}
                      name="diagnosis"
                      render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel>Diagnosis / Chief Complaint *</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-diagnosis" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={encounterForm.control}
                      name="urgency"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Urgency Level *</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-urgency">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="routine">Routine</SelectItem>
                              <SelectItem value="urgent">Urgent</SelectItem>
                              <SelectItem value="emergency">Emergency</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={encounterForm.control}
                      name="icd10Code"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>ICD-10 Code</FormLabel>
                          <FormControl>
                            <ICD10Search
                              value={field.value || ""}
                              onChange={field.onChange}
                              placeholder="Search by code (e.g., I10, E11) or description..."
                            />
                          </FormControl>
                          <FormDescription>
                            Search for diagnosis codes to automatically fill in the ICD-10 code
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={encounterForm.control}
                    name="referralReason"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Referral Reason</FormLabel>
                        <FormControl>
                          <Textarea {...field} value={field.value || ""} data-testid="textarea-referral-reason" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={encounterForm.control}
                    name="medicalHistory"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Medical History</FormLabel>
                        <FormControl>
                          <Textarea {...field} value={field.value || ""} data-testid="textarea-medical-history" />
                        </FormControl>
                        <FormDescription>
                          One condition per line — each line is added to the patient's Medical Problems list in OpenEMR
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={encounterForm.control}
                    name="currentMedications"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Current Medications</FormLabel>
                        <FormControl>
                          <Textarea {...field} value={field.value || ""} data-testid="textarea-medications" />
                        </FormControl>
                        <FormDescription>
                          One medication per line, with dose (e.g. Lisinopril 10 mg daily) — added to the Medications list in OpenEMR
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Separator />

                  <h3 className="text-lg font-semibold">Insurance Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={encounterForm.control}
                      name="insurancePlan"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Insurance Plan</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} data-testid="input-insurance-plan" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="policyNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Policy Number</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} data-testid="input-policy-number" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="groupNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Group Number</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value || ""} data-testid="input-group-number" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="effectiveDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Effective Date</FormLabel>
                          <FormControl>
                            <Input type="date" {...field} value={field.value || ""} data-testid="input-effective-date" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="insuranceEndDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>End Date</FormLabel>
                          <FormControl>
                            <Input type="date" {...field} value={field.value || ""} data-testid="input-insurance-end-date" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="subscriberRelationship"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Patient's Relationship to Subscriber</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-subscriber-relationship">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="self">Self</SelectItem>
                              <SelectItem value="spouse">Spouse</SelectItem>
                              <SelectItem value="child">Child</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Insurance is optional. Once you fill in any insurance field, plan, policy number, effective date and end date are required.
                  </p>

                  {subscriberRelationship !== "self" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={encounterForm.control}
                        name="subscriberFirstName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Subscriber First Name *</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ""} data-testid="input-subscriber-first-name" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={encounterForm.control}
                        name="subscriberLastName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Subscriber Last Name *</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ""} data-testid="input-subscriber-last-name" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={encounterForm.control}
                        name="subscriberDob"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Subscriber Date of Birth *</FormLabel>
                            <FormControl>
                              <Input type="date" {...field} value={field.value || ""} data-testid="input-subscriber-dob" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={encounterForm.control}
                        name="subscriberSex"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Subscriber Sex *</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger data-testid="select-subscriber-sex">
                                  <SelectValue placeholder="Select" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="male">Male</SelectItem>
                                <SelectItem value="female">Female</SelectItem>
                                <SelectItem value="other">Other</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={encounterForm.control}
                      name="subscriberSsn"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Subscriber SSN</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value || ""}
                              inputMode="numeric"
                              autoComplete="off"
                              placeholder="XXX-XX-XXXX"
                              data-testid="input-subscriber-ssn"
                            />
                          </FormControl>
                          <FormDescription>
                            Optional. If blank, a placeholder (999-…) is used in OpenEMR — replace it before billing.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={encounterForm.control}
                      name="acceptAssignment"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Accept Assignment</FormLabel>
                          <Select
                            onValueChange={(v) => field.onChange(v === "yes")}
                            value={field.value ? "yes" : "no"}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-accept-assignment">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="yes">Yes</SelectItem>
                              <SelectItem value="no">No</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={encounterForm.control}
                    name="sameAddressAsPatient"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                            data-testid="checkbox-same-address"
                          />
                        </FormControl>
                        <FormLabel className="font-normal">Subscriber address is the same as the patient's</FormLabel>
                      </FormItem>
                    )}
                  />

                  {!sameAddressAsPatient && (
                    <div className="space-y-4">
                      <FormField
                        control={encounterForm.control}
                        name="subscriberStreet"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Subscriber Street Address *</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ""} data-testid="input-subscriber-street" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] gap-4">
                        <FormField
                          control={encounterForm.control}
                          name="subscriberCity"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>City *</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value || ""} data-testid="input-subscriber-city" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={encounterForm.control}
                          name="subscriberState"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>State *</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value || ""} maxLength={2} placeholder="CA" data-testid="input-subscriber-state" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={encounterForm.control}
                          name="subscriberPostalCode"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>ZIP *</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value || ""} inputMode="numeric" data-testid="input-subscriber-postal-code" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  )}

                  <Separator />

                  <FormField
                    control={encounterForm.control}
                    name="referringProviderNpi"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Referring Provider NPI</FormLabel>
                        <div className="flex gap-2">
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value || ""}
                              inputMode="numeric"
                              maxLength={10}
                              placeholder="10-digit NPI"
                              data-testid="input-provider-npi"
                            />
                          </FormControl>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={lookupReferringNpi}
                            disabled={npiLookupLoading}
                            data-testid="button-lookup-provider-npi"
                          >
                            <Search className="h-4 w-4 mr-2" />
                            {npiLookupLoading ? "Looking up..." : "Look up"}
                          </Button>
                        </div>
                        <FormDescription>
                          Optional. With an NPI, the provider is added to the OpenEMR Address Book and set as the referring provider.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={encounterForm.control}
                      name="referringProvider"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Referring Provider *</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-provider" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={encounterForm.control}
                      name="providerContact"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Provider Contact *</FormLabel>
                          <FormControl>
                            <Input {...field} data-testid="input-provider-contact" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Paperclip className="h-5 w-5" />
                    Documents
                  </CardTitle>
                  <CardDescription>
                    Optional. Referral letters, notes, lab results, insurance cards. They go into the patient's chart in OpenEMR.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DocumentUpload
                    documents={documents}
                    onChange={setDocuments}
                    disabled={createEncounterMutation.isPending || createPatientMutation.isPending}
                  />
                </CardContent>
              </Card>

              <div className="flex gap-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLocation("/")}
                  data-testid="button-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createEncounterMutation.isPending || createPatientMutation.isPending || uploadingDocuments}
                  data-testid="button-submit"
                >
                  {createEncounterMutation.isPending || createPatientMutation.isPending
                    ? "Creating..."
                    : uploadingDocuments ? "Uploading files..." : "Create Encounter"}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </div>
    </div>
  );
}
