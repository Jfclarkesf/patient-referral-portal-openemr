// Common dermatology ICD-10 codes
export const commonICD10Codes = [
  { code: "R21", description: "Rash and other nonspecific skin eruption" },
  { code: "L27.0", description: "Generalized skin eruption due to drugs and medicaments" },
  { code: "L40.0", description: "Psoriasis vulgaris" },
  { code: "L40.1", description: "Generalized pustular psoriasis" },
  { code: "L40.4", description: "Guttate psoriasis" },
  { code: "L40.8", description: "Other psoriasis" },
  { code: "L40.9", description: "Psoriasis, unspecified" },
  { code: "D48.5", description: "Neoplasm of uncertain behavior of skin" },
  { code: "L89", description: "Pressure ulcer" },
  { code: "L89.9", description: "Pressure ulcer, unspecified" },
  { code: "L20", description: "Atopic dermatitis" },
  { code: "L20.9", description: "Atopic dermatitis, unspecified" },
  { code: "L30", description: "Other dermatitis" },
  { code: "L30.9", description: "Dermatitis, unspecified" },
  { code: "L50", description: "Urticaria" },
  { code: "L50.9", description: "Urticaria, unspecified" },
  { code: "L51", description: "Erythema multiforme" },
  { code: "L51.9", description: "Erythema multiforme, unspecified" },
  { code: "L55", description: "Sunburn" },
  { code: "L55.9", description: "Sunburn, unspecified" },
  { code: "L60", description: "Nail disorders" },
  { code: "L60.9", description: "Nail disorder, unspecified" },
  { code: "L70", description: "Acne" },
  { code: "L70.9", description: "Acne, unspecified" },
  { code: "L80", description: "Vitiligo" },
  { code: "L81", description: "Other disorders of pigmentation" },
  { code: "L81.4", description: "Chloasma" },
  { code: "L82", description: "Seborrheic keratosis" },
  { code: "L82.1", description: "Seborrheic keratosis" },
  { code: "L84", description: "Corns and callosities" },
  { code: "L85", description: "Other epidermal thickening" },
  { code: "L86", description: "Keratoderma in diseases classified elsewhere" },
  { code: "C44", description: "Malignant neoplasm of skin" },
  { code: "C44.9", description: "Malignant neoplasm of skin, unspecified" },
  { code: "D23", description: "Benign neoplasm of skin" },
  { code: "D23.9", description: "Benign neoplasm of skin, unspecified" },
];

export function searchICD10Codes(query: string): typeof commonICD10Codes {
  if (!query.trim()) return [];
  
  const q = query.toLowerCase();
  return commonICD10Codes.filter(
    item => 
      item.code.toLowerCase().includes(q) || 
      item.description.toLowerCase().includes(q)
  ).slice(0, 10); // Return top 10 results
}
