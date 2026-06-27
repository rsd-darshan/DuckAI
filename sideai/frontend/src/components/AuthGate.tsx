import { SignIn, SignUp, useUser } from "@clerk/clerk-react";
import { useState } from "react";

interface Props {
  /** If provided, show a locked-feature teaser instead of a raw modal */
  feature?: string;
  /** Called when the user closes the gate without signing in */
  onDismiss?: () => void;
}

/**
 * AuthGate — shown when an unauthenticated user tries to access a cloud feature.
 * The app remains fully functional without signing in; this gate only appears
 * when the user explicitly tries a feature that requires an account (cloud sync, etc.).
 */
export function AuthGate({ feature, onDismiss }: Props) {
  const { isSignedIn } = useUser();
  const [mode, setMode] = useState<"signin" | "signup">("signup");

  if (isSignedIn) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-[#13131a] border border-white/10 rounded-2xl p-6 w-full max-w-sm flex flex-col gap-5 shadow-2xl">
        {/* Header */}
        <div className="text-center">
          <div className="text-3xl mb-2">☁️</div>
          <h2 className="text-lg font-bold text-white">
            {feature ? `${feature} requires an account` : "Sign in to DuckAI"}
          </h2>
          <p className="text-sm text-white/50 mt-1">
            Free to create · your local data stays local
          </p>
        </div>

        {/* Clerk embedded form */}
        <div className="clerk-auth-container">
          {mode === "signup" ? (
            <SignUp
              appearance={{
                elements: {
                  rootBox: "w-full",
                  card: "bg-transparent shadow-none border-0 p-0",
                  headerTitle: "hidden",
                  headerSubtitle: "hidden",
                  socialButtonsBlockButton:
                    "bg-white/5 border border-white/10 text-white hover:bg-white/10 rounded-xl h-10",
                  dividerLine: "bg-white/10",
                  dividerText: "text-white/30 text-xs",
                  formFieldInput:
                    "bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-lg focus:border-indigo-500",
                  formFieldLabel: "text-white/60 text-xs",
                  formButtonPrimary:
                    "bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl h-10 font-semibold",
                  footerActionLink: "text-indigo-400 hover:text-indigo-300",
                  footerActionText: "text-white/40",
                  identityPreviewText: "text-white/80",
                  identityPreviewEditButton: "text-indigo-400",
                  alertText: "text-red-400",
                  formFieldErrorText: "text-red-400 text-xs",
                },
                variables: {
                  colorBackground: "transparent",
                  colorText: "#ffffff",
                  colorPrimary: "#6366f1",
                  colorInputBackground: "rgba(255,255,255,0.05)",
                  colorInputText: "#ffffff",
                  borderRadius: "0.75rem",
                },
              }}
            />
          ) : (
            <SignIn
              appearance={{
                elements: {
                  rootBox: "w-full",
                  card: "bg-transparent shadow-none border-0 p-0",
                  headerTitle: "hidden",
                  headerSubtitle: "hidden",
                  socialButtonsBlockButton:
                    "bg-white/5 border border-white/10 text-white hover:bg-white/10 rounded-xl h-10",
                  dividerLine: "bg-white/10",
                  dividerText: "text-white/30 text-xs",
                  formFieldInput:
                    "bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-lg focus:border-indigo-500",
                  formFieldLabel: "text-white/60 text-xs",
                  formButtonPrimary:
                    "bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl h-10 font-semibold",
                  footerActionLink: "text-indigo-400 hover:text-indigo-300",
                  footerActionText: "text-white/40",
                  alertText: "text-red-400",
                  formFieldErrorText: "text-red-400 text-xs",
                },
                variables: {
                  colorBackground: "transparent",
                  colorText: "#ffffff",
                  colorPrimary: "#6366f1",
                  colorInputBackground: "rgba(255,255,255,0.05)",
                  colorInputText: "#ffffff",
                  borderRadius: "0.75rem",
                },
              }}
            />
          )}
        </div>

        {/* Toggle sign-in / sign-up */}
        <div className="text-center text-xs text-white/40">
          {mode === "signup" ? (
            <>
              Already have an account?{" "}
              <button
                className="text-indigo-400 hover:text-indigo-300"
                onClick={() => setMode("signin")}
              >
                Sign in
              </button>
            </>
          ) : (
            <>
              No account yet?{" "}
              <button
                className="text-indigo-400 hover:text-indigo-300"
                onClick={() => setMode("signup")}
              >
                Create one free
              </button>
            </>
          )}
        </div>

        {/* Dismiss */}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-xs text-white/30 hover:text-white/50 text-center transition-colors"
          >
            Continue without account
          </button>
        )}
      </div>
    </div>
  );
}
