CREATE TABLE "referrals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_number" varchar NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"date_of_birth" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"diagnosis" text NOT NULL,
	"urgency" varchar NOT NULL,
	"medical_history" text,
	"current_medications" text,
	"referring_provider" text NOT NULL,
	"provider_contact" text NOT NULL,
	"document_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" varchar DEFAULT 'submitted' NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_reference_number_unique" UNIQUE("reference_number")
);
