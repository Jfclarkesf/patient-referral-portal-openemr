import { createContext, useContext, ReactNode, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@shared/schema";

interface AuthResponse {
  user: User | null;
}

type AuthStatus = "unknown" | "guest" | "authenticated";

interface AuthContextType {
  user: User | null;
  authStatus: AuthStatus;
  isHydrating: boolean;
  hydrationError: Error | null;
  refetch: () => Promise<any>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  
  const { data, error, refetch, isFetched, isLoading } = useQuery<AuthResponse>({
    queryKey: ["/api/auth/user"],
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 0, // Always refetch to ensure fresh auth state
  });

  const user = data?.user ?? null;
  
  // Three-state auth model with logout override
  let authStatus: AuthStatus;
  if (isLoggingOut) {
    // During logout, immediately switch to guest state
    authStatus = "guest";
  } else if (!isFetched) {
    authStatus = "unknown";
  } else if (user) {
    authStatus = "authenticated";
  } else {
    authStatus = "guest";
  }

  const isHydrating = !isFetched && isLoading;
  
  // Clear error after successful fetch
  const hydrationError = error && !data && isFetched ? (error as Error) : null;

  const logout = async () => {
    try {
      // Set logging out flag to immediately flip authStatus to "guest"
      setIsLoggingOut(true);

      // Call backend logout endpoint
      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "include",
      });
      
      if (!response.ok) {
        throw new Error("Logout failed");
      }
      
      // Clear auth cache
      queryClient.setQueryData(["/api/auth/user"], { user: null });
      
      // Invalidate to confirm logout
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    } catch (error) {
      console.error("Logout error:", error);
      // Even if logout fails, clear local state
      queryClient.setQueryData(["/api/auth/user"], { user: null });
    } finally {
      // Clear logging out flag after process completes
      setIsLoggingOut(false);
    }
  };

  const value: AuthContextType = {
    user: isLoggingOut ? null : user,
    authStatus,
    isHydrating,
    hydrationError,
    refetch,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
