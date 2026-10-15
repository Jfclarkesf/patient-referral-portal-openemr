import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { SetupStatus } from "@/pages/setup";

// Send visitors to the setup wizard until the first admin account exists
export function useFirstRunRedirect(enabled = true) {
  const [, setLocation] = useLocation();
  const { data } = useQuery<SetupStatus>({
    queryKey: ["/api/setup/status"],
    enabled,
    retry: false,
  });

  useEffect(() => {
    if (enabled && data?.needsAdmin) setLocation("/setup");
  }, [enabled, data?.needsAdmin, setLocation]);
}
