import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { insertReferralSchema, type InsertReferral } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ClipboardCheck, User, Search, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface OpenEMRPatient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
  email?: string;
  phone?: string;
  primaryLanguage?: string;
  insurancePlan?: string;
  policyNumber?: string;
  groupNumber?: string;
  effectiveDate?: string;
}

export default function NewReferral() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [searchFirstName, setSearchFirstName] = useState("");
  const [searchLastName, setSearchLastName] = useState("");
  const [searchResults, setSearchResults] = useState<OpenEMRPatient[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const form = useForm<InsertReferral>({
    resolver: zodResolver(insertReferralSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      dateOfBirth: "",
      gender: "male",
      email: "",
      phone: "",
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
      primaryLanguage: "",
      referringProvider: "",
      providerContact: "",
      status: "submitted",
    },
  });

  const createReferralMutation = useMutation({
    mutationFn: async (data: InsertReferral) => {
      const response = await apiRequest("POST", "/api/referrals", data);
      return await response.json();
    },
    onSuccess: async (data: { referenceNumber: string }) => {
      await queryClient.invalidateQueries({ 
        queryKey: ["/api/referrals"],
        refetchType: 'all'
      });
      toast({
        title: "Referral Submitted",
        description: `Reference number: ${data.referenceNumber}`,
      });
      setLocation(`/confirmation/${data.referenceNumber}`);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to submit referral. Please try again.",
        variant: "destructive",
      });
    },
  });


  const handleSearchPatients = async () => {
    if (!searchFirstName && !searchLastName) {
      toast({
        title: "Search Required",
        description: "Please enter at least a first name or last name to search",
        variant: "destructive",
      });
      return;
    }

    setIsSearching(true);
    try {
      const params = new URLSearchParams();
      if (searchFirstName) params.append("firstName", searchFirstName);
      if (searchLastName) params.append("lastName", searchLastName);

      const response = await apiRequest("GET", `/api/openemr/patients/search?${params.toString()}`);
      const data = await response.json();
      
      setSearchResults(data.patients || []);
      
      if (data.patients && data.patients.length === 0) {
        toast({
          title: "No Results",
          description: "No patients found matching your search criteria",
        });
      }
    } catch (error) {
      toast({
        title: "Search Error",
        description: "Failed to search OpenEMR. Please try again.",
        variant: "destructive",
      });
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectPatient = (patient: OpenEMRPatient) => {
    // Populate basic patient information
    form.setValue("firstName", patient.firstName);
    form.setValue("lastName", patient.lastName);
    form.setValue("dateOfBirth", patient.dateOfBirth);
    
    // Populate gender if available
    if (patient.gender) {
      form.setValue("gender", patient.gender as "male" | "female" | "other");
    }
    
    // Populate contact information
    if (patient.email) form.setValue("email", patient.email);
    if (patient.phone) form.setValue("phone", patient.phone);
    
    // Populate primary language
    if (patient.primaryLanguage) {
      form.setValue("primaryLanguage", patient.primaryLanguage);
    }
    
    // Populate insurance information
    if (patient.insurancePlan) {
      form.setValue("insurancePlan", patient.insurancePlan);
    }
    if (patient.policyNumber) {
      form.setValue("policyNumber", patient.policyNumber);
    }
    if (patient.groupNumber) {
      form.setValue("groupNumber", patient.groupNumber);
    }
    if (patient.effectiveDate) {
      form.setValue("effectiveDate", patient.effectiveDate);
    }
    
    setSearchDialogOpen(false);
    setSearchResults([]);
    setSearchFirstName("");
    setSearchLastName("");
    
    toast({
      title: "Patient Selected",
      description: `${patient.firstName} ${patient.lastName}'s information has been loaded from OpenEMR`,
    });
  };

  const onSubmit = (data: InsertReferral) => {
    createReferralMutation.mutate(data);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-3">
            <ClipboardCheck className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-3xl font-medium text-foreground">Patient Referral System</h1>
              <p className="text-sm text-muted-foreground mt-1">Streamlined healthcare referral management</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Button variant="outline" onClick={() => setLocation("/")} data-testid="button-back">
            ← Back to Referrals
          </Button>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <User className="h-5 w-5 text-primary" />
                      <CardTitle className="text-xl">Patient Information</CardTitle>
                    </div>
                    <CardDescription className="mt-2">Enter the patient's personal and contact details</CardDescription>
                  </div>
                  <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" data-testid="button-search-patient">
                        <Search className="h-4 w-4 mr-2" />
                        Search OpenEMR
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Search OpenEMR Patients</DialogTitle>
                        <DialogDescription>
                          Search for an existing patient in OpenEMR to auto-populate the form
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label htmlFor="search-first-name" className="text-sm font-medium">
                              First Name
                            </label>
                            <Input
                              id="search-first-name"
                              placeholder="John"
                              value={searchFirstName}
                              onChange={(e) => setSearchFirstName(e.target.value)}
                              data-testid="input-search-first-name"
                            />
                          </div>
                          <div className="space-y-2">
                            <label htmlFor="search-last-name" className="text-sm font-medium">
                              Last Name
                            </label>
                            <Input
                              id="search-last-name"
                              placeholder="Doe"
                              value={searchLastName}
                              onChange={(e) => setSearchLastName(e.target.value)}
                              data-testid="input-search-last-name"
                            />
                          </div>
                        </div>
                        <Button
                          onClick={handleSearchPatients}
                          disabled={isSearching}
                          className="w-full"
                          data-testid="button-perform-search"
                        >
                          {isSearching ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Searching...
                            </>
                          ) : (
                            <>
                              <Search className="h-4 w-4 mr-2" />
                              Search
                            </>
                          )}
                        </Button>

                        {searchResults.length > 0 && (
                          <div className="space-y-2 max-h-96 overflow-y-auto">
                            <p className="text-sm font-medium">Search Results ({searchResults.length})</p>
                            {searchResults.map((patient) => (
                              <Card
                                key={patient.id}
                                data-testid={`patient-result-${patient.id}`}
                              >
                                <CardContent className="p-4">
                                  <div className="flex justify-between items-start gap-4">
                                    <div className="flex-1">
                                      <p className="font-medium">
                                        {patient.firstName} {patient.lastName}
                                      </p>
                                      <p className="text-sm text-muted-foreground">
                                        DOB: {patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString() : 'N/A'}
                                      </p>
                                      {patient.email && (
                                        <p className="text-sm text-muted-foreground">{patient.email}</p>
                                      )}
                                      {patient.phone && (
                                        <p className="text-sm text-muted-foreground">{patient.phone}</p>
                                      )}
                                    </div>
                                    <Button 
                                      size="sm" 
                                      variant="ghost"
                                      onClick={() => handleSelectPatient(patient)}
                                      data-testid={`button-select-patient-${patient.id}`}
                                    >
                                      Select
                                    </Button>
                                  </div>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        )}
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First Name *</FormLabel>
                        <FormControl>
                          <Input placeholder="John" {...field} data-testid="input-first-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Name *</FormLabel>
                        <FormControl>
                          <Input placeholder="Doe" {...field} data-testid="input-last-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="dateOfBirth"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Date of Birth *</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} data-testid="input-date-of-birth" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email *</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="john.doe@example.com" {...field} data-testid="input-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone Number *</FormLabel>
                        <FormControl>
                          <Input type="tel" placeholder="(555) 123-4567" {...field} data-testid="input-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="primaryLanguage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Primary Language</FormLabel>
                      <FormControl>
                        <Input placeholder="If not English" {...field} data-testid="input-primary-language" />
                      </FormControl>
                      <FormDescription>Optional - Leave blank if English</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-xl">Medical Details</CardTitle>
                </div>
                <CardDescription>Provide relevant medical information for this referral</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField
                  control={form.control}
                  name="diagnosis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Diagnosis *</FormLabel>
                      <FormControl>
                        <Input placeholder="Primary diagnosis or reason for referral" {...field} data-testid="input-diagnosis" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="urgency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Urgency Level *</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-urgency">
                            <SelectValue placeholder="Select urgency level" />
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
                  control={form.control}
                  name="medicalHistory"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Medical History</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Relevant medical history, previous treatments, or conditions"
                          className="min-h-24"
                          {...field}
                          data-testid="input-medical-history"
                        />
                      </FormControl>
                      <FormDescription>Optional but recommended</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="currentMedications"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current Medications</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="List current medications and dosages"
                          className="min-h-24"
                          {...field}
                          data-testid="input-current-medications"
                        />
                      </FormControl>
                      <FormDescription>Optional but recommended</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="icd10Code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>ICD-10 Code</FormLabel>
                      <FormControl>
                        <Input placeholder="ICD-10 Code" {...field} data-testid="input-icd10-code" />
                      </FormControl>
                      <FormDescription>Optional</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="referralReason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Referral Reason</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Ex: Evaluation and Management of Rash"
                          className="min-h-24"
                          {...field}
                          data-testid="input-referral-reason"
                        />
                      </FormControl>
                      <FormDescription>Optional - Detailed reason for referral</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl">Insurance Information</CardTitle>
                </div>
                <CardDescription>Patient insurance details</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField
                  control={form.control}
                  name="insurancePlan"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Insurance Plan</FormLabel>
                      <FormControl>
                        <Input placeholder="Plan name or provider" {...field} data-testid="input-insurance-plan" />
                      </FormControl>
                      <FormDescription>Optional</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="policyNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Policy Number</FormLabel>
                        <FormControl>
                          <Input placeholder="Policy #" {...field} data-testid="input-policy-number" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="groupNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Group Number</FormLabel>
                        <FormControl>
                          <Input placeholder="Group #" {...field} data-testid="input-group-number" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="effectiveDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Effective Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-effective-date" />
                      </FormControl>
                      <FormDescription>Optional - Insurance effective date</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl">Referring Provider</CardTitle>
                </div>
                <CardDescription>Information about the healthcare provider making this referral</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField
                  control={form.control}
                  name="referringProvider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Provider Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Dr. Jane Smith" {...field} data-testid="input-referring-provider" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="providerContact"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Provider Contact *</FormLabel>
                      <FormControl>
                        <Input placeholder="Email or phone number" {...field} data-testid="input-provider-contact" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <div className="flex justify-end gap-4">
              <Button type="button" variant="outline" onClick={() => setLocation("/")} data-testid="button-cancel">
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createReferralMutation.isPending}
                data-testid="button-submit-referral"
              >
                {createReferralMutation.isPending ? "Submitting..." : "Submit Referral"}
              </Button>
            </div>
          </form>
        </Form>
      </main>
    </div>
  );
}
