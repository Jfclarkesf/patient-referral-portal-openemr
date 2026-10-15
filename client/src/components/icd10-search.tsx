import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { X, Search } from "lucide-react";

interface ICD10Code {
  code: string;
  description: string;
}

interface ICD10SearchProps {
  value?: string;
  onChange: (code: string) => void;
  placeholder?: string;
}

export function ICD10Search({ value = "", onChange, placeholder = "Search by code or description..." }: ICD10SearchProps) {
  const [searchInput, setSearchInput] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  // Fetch ICD-10 codes based on search input
  const { data: results = [], isLoading } = useQuery<ICD10Code[]>({
    queryKey: ["/api/icd10/search", searchInput],
    queryFn: async () => {
      if (!searchInput.trim()) return [];
      const response = await fetch(`/api/icd10/search?q=${encodeURIComponent(searchInput)}`);
      if (!response.ok) throw new Error("Failed to search ICD-10 codes");
      return response.json();
    },
    enabled: searchInput.length > 0,
  });

  const handleSelect = useCallback((code: string) => {
    onChange(code);
    setSearchInput("");
    setIsOpen(false);
  }, [onChange]);

  const handleClear = useCallback(() => {
    onChange("");
    setSearchInput("");
    setIsOpen(false);
  }, [onChange]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setSearchInput(newValue);
    setIsOpen(true);
  }, []);

  const handleInputFocus = useCallback(() => {
    setIsOpen(searchInput.length > 0);
  }, [searchInput.length]);

  const handleInputBlur = useCallback(() => {
    // Delay closing to allow clicking suggestions
    setTimeout(() => setIsOpen(false), 200);
  }, []);

  // Get description for currently selected code
  const selectedDescription = results.find(r => r.code === value)?.description || "";

  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              value={searchInput}
              onChange={handleInputChange}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              placeholder={placeholder}
              className="pl-9"
              data-testid="input-icd10-search"
              autoComplete="off"
            />
          </div>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClear}
              data-testid="button-clear-icd10"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Suggestions dropdown */}
        {isOpen && searchInput.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-background border border-input rounded-md shadow-md">
            <div className="max-h-64 overflow-y-auto py-1">
              {isLoading ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  Searching...
                </div>
              ) : results.length > 0 ? (
                results.map((result) => (
                  <button
                    key={result.code}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none transition-colors"
                    onClick={() => handleSelect(result.code)}
                    data-testid={`button-icd10-${result.code}`}
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm">{result.code}</span>
                      <span className="text-xs text-muted-foreground">{result.description}</span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No codes found
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Selected code display */}
      {value && (
        <Card className="p-3 bg-muted">
          <div className="space-y-1">
            <p className="font-semibold text-sm">{value}</p>
            {selectedDescription && (
              <p className="text-xs text-muted-foreground">{selectedDescription}</p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
