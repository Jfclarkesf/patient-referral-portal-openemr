import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ClipboardCheck, FileText, Shield, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";

export default function Landing() {
  const { data: authMode } = useQuery<{ mode: string }>({
    queryKey: ["/api/auth/mode"],
  });

  const handleLogin = () => {
    if (authMode?.mode === "standalone") {
      window.location.href = "/login";
    } else {
      window.location.href = "/api/login";
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ClipboardCheck className="h-8 w-8 text-primary" />
              <h1 className="text-2xl font-medium text-foreground">Patient Referral System</h1>
            </div>
            <Button 
              onClick={handleLogin}
              data-testid="button-login"
            >
              Sign In
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-medium text-foreground mb-4">
            Streamlined Healthcare Referral Management
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Securely manage patient referrals with our professional platform designed for healthcare providers.
          </p>
          <div className="mt-8">
            <Button 
              size="lg"
              onClick={handleLogin}
              data-testid="button-get-started"
            >
              Get Started
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-8 mb-16">
          <Card>
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="p-4 bg-primary/10 rounded-full">
                  <FileText className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-xl font-medium text-foreground">Easy Submissions</h3>
                <p className="text-muted-foreground">
                  Submit referrals with comprehensive patient information and medical documentation
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="p-4 bg-primary/10 rounded-full">
                  <Shield className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-xl font-medium text-foreground">Secure & Compliant</h3>
                <p className="text-muted-foreground">
                  Enterprise-grade security with encrypted data storage and access controls
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="p-4 bg-primary/10 rounded-full">
                  <Zap className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-xl font-medium text-foreground">Real-time Tracking</h3>
                <p className="text-muted-foreground">
                  Track referral status and manage your submissions with instant updates
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="text-center">
          <p className="text-muted-foreground">
            Sign in to access the platform and start managing patient referrals
          </p>
        </div>
      </main>
    </div>
  );
}
