import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircleIcon, XCircleIcon } from "lucide-react";

export default function OAuthCallback() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    // Parse query parameters
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const error = params.get('error');

    if (success === 'true') {
      setStatus('success');
    } else if (error) {
      setStatus('error');
      // Map error codes to user-friendly messages
      const errorMessages: Record<string, string> = {
        // Backend-generated errors
        'not_configured': 'OpenEMR is not configured. Please contact your administrator.',
        'invalid_state': 'Security validation failed. Please try again.',
        'state_expired': 'Authorization request expired. Please try again.',
        'missing_code': 'Authorization failed. No authorization code received.',
        'token_exchange_failed': 'Failed to obtain access token. Please try again.',
        'server_error': 'Server error occurred. Please try again later.',
        // Standard OAuth error codes
        'access_denied': 'You denied access to OpenEMR. To use sync features, please authorize the application.',
        'invalid_request': 'Invalid OAuth request. Please try again or contact support.',
        'unauthorized_client': 'This application is not authorized to access OpenEMR. Please contact your administrator.',
        'invalid_scope': 'The requested permissions are not available. Please contact your administrator.',
        'temporarily_unavailable': 'OpenEMR authorization server is temporarily unavailable. Please try again later.',
      };
      setErrorMessage(errorMessages[error] || 'An unknown error occurred. Please try again.');
    } else {
      // No success or error param - shouldn't happen, treat as error
      setStatus('error');
      setErrorMessage('Invalid callback state. Please try again.');
    }
  }, []);

  const handleContinue = () => {
    setLocation('/');
  };

  const handleTryAgain = () => {
    setLocation('/');
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <CardTitle>Processing Authorization</CardTitle>
            <CardDescription>Please wait while we complete the authorization...</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <CheckCircleIcon className="h-16 w-16 text-green-600" data-testid="icon-success" />
            </div>
            <CardTitle className="text-2xl">Authorization Successful</CardTitle>
            <CardDescription>
              Your OpenEMR account has been successfully connected.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground text-center">
              You can now sync referrals with your OpenEMR system.
            </p>
            <Button 
              onClick={handleContinue} 
              className="w-full"
              data-testid="button-continue"
            >
              Continue
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <XCircleIcon className="h-16 w-16 text-destructive" data-testid="icon-error" />
          </div>
          <CardTitle className="text-2xl">Authorization Failed</CardTitle>
          <CardDescription>
            There was a problem connecting your OpenEMR account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorMessage && (
            <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md" data-testid="text-error-message">
              {errorMessage}
            </div>
          )}
          <Button 
            onClick={handleTryAgain} 
            className="w-full"
            data-testid="button-try-again"
          >
            Return to Application
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
