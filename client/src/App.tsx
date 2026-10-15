import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import Landing from "@/pages/landing";
import Login from "@/pages/login";
import Register from "@/pages/register";
import ReferralList from "@/pages/referral-list";
import PatientList from "@/pages/patient-list";
import PatientProfile from "@/pages/patient-profile";
import NewReferral from "@/pages/new-referral";
import NewEncounter from "@/pages/new-encounter";
import ReferralDetail from "@/pages/referral-detail";
import EncounterDetail from "@/pages/encounter-detail";
import Confirmation from "@/pages/confirmation";
import OAuthCallback from "@/pages/oauth-callback";
import Setup from "@/pages/setup";
import AdminDashboard from "@/pages/admin-dashboard";
import UserManagement from "@/pages/user-management";
import NotFound from "@/pages/not-found";
import AppHeader from "@/components/app-header";
import { useFirstRunRedirect } from "@/hooks/use-first-run";

// Protected route wrapper using three-state auth model
function ProtectedRoute<T extends Record<string, any>>({ 
  component: Component,
  ...props
}: { component: React.ComponentType<T> } & T) {
  const { authStatus, hydrationError, refetch } = useAuth();
  const [, setLocation] = useLocation();

  // Navigate to login if guest (must be before any conditional returns)
  useEffect(() => {
    if (authStatus === "guest") {
      setLocation("/login");
    }
  }, [authStatus, setLocation]);

  // Show loading while auth state is unknown
  if (authStatus === "unknown") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Show error state if hydration failed
  if (hydrationError) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <p className="text-destructive font-medium mb-2">Unable to verify authentication</p>
          <p className="text-sm text-muted-foreground mb-4">
            Unable to connect to the server. Please check your connection.
          </p>
          <Button onClick={() => refetch()} data-testid="button-retry-auth">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // If guest, navigation effect will redirect to /login
  if (authStatus === "guest") {
    return null;
  }

  // Render component for authenticated users
  return <Component {...(props as T)} />;
}

// Auth gate for home route - shows loading for authenticated users during hydration
function AuthGate() {
  const { authStatus } = useAuth();
  useFirstRunRedirect(authStatus === "guest");

  // Show loading spinner while auth state is unknown
  if (authStatus === "unknown") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Show patient list for authenticated users
  if (authStatus === "authenticated") {
    return <PatientList />;
  }

  // Show landing page for guests
  return <Landing />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={AuthGate} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/setup" component={Setup} />
      <Route path="/oauth/callback" component={OAuthCallback} />
      <Route path="/admin">
        <ProtectedRoute component={AdminDashboard} />
      </Route>
      <Route path="/admin/users">
        <ProtectedRoute component={UserManagement} />
      </Route>
      <Route path="/patients">
        <ProtectedRoute component={PatientList} />
      </Route>
      <Route path="/old-referrals">
        <ProtectedRoute component={ReferralList} />
      </Route>
      <Route path="/patients/:id">
        {(params) => <ProtectedRoute component={PatientProfile} {...params} />}
      </Route>
      <Route path="/new-referral">
        <ProtectedRoute component={NewEncounter} />
      </Route>
      <Route path="/new-referral-old">
        <ProtectedRoute component={NewReferral} />
      </Route>
      <Route path="/referrals/:referenceNumber">
        {(params) => <ProtectedRoute component={ReferralDetail} {...params} />}
      </Route>
      <Route path="/encounters/:referenceNumber">
        {(params) => <ProtectedRoute component={EncounterDetail} {...params} />}
      </Route>
      <Route path="/confirmation/:referenceNumber">
        {(params) => <ProtectedRoute component={Confirmation} {...params} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function AppWrapper() {
  const { authStatus } = useAuth();

  // Always mount router so routes can handle their own gating
  return (
    <>
      {authStatus === "authenticated" && <AppHeader />}
      <Router />
      <Toaster />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <AppWrapper />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
