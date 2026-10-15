/**
 * NPPES NPI Registry lookup (free, public CMS API — no key required).
 * https://npiregistry.cms.hhs.gov/api-page
 */

export interface NpiLookupResult {
  npi: string;
  type: "individual" | "organization";
  active: boolean;
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

// The registry returns names and addresses in ALL CAPS
function titleCase(raw: string | undefined): string {
  return (raw || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function formatZip(raw: string | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits.slice(0, 5);
}

function formatPhone(raw: string | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length !== 10) return raw || "";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Returns the registry record, or null if the NPI isn't in the registry.
 * Throws if the registry itself can't be reached.
 */
export async function lookupNpi(npi: string): Promise<NpiLookupResult | null> {
  const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${encodeURIComponent(npi)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let body: any;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`NPI registry returned ${response.status}`);
    }
    body = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  const record = body?.results?.[0];
  if (!record) return null;

  const basic = record.basic || {};
  const addresses: any[] = record.addresses || [];
  const location =
    addresses.find((a) => a.address_purpose === "LOCATION") || addresses[0] || {};
  const taxonomies: any[] = record.taxonomies || [];
  const taxonomy = taxonomies.find((t) => t.primary) || taxonomies[0] || {};

  const isIndividual = record.enumeration_type === "NPI-1";

  return {
    npi,
    type: isIndividual ? "individual" : "organization",
    active: (basic.status || "A") === "A",
    firstName: titleCase(basic.first_name),
    lastName: titleCase(basic.last_name),
    credential: (basic.credential || "").replace(/\./g, ""),
    specialty: taxonomy.desc || "",
    practiceName: isIndividual ? "" : titleCase(basic.organization_name),
    street: titleCase([location.address_1, location.address_2].filter(Boolean).join(", ")),
    city: titleCase(location.city),
    state: location.state || "",
    zip: formatZip(location.postal_code),
    phone: formatPhone(location.telephone_number),
    fax: formatPhone(location.fax_number),
  };
}
