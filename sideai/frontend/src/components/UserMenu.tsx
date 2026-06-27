import { useUser, useClerk, UserButton } from "@clerk/clerk-react";
import { useEffect, useState } from "react";

const CLERK_ENABLED = Boolean(
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim()
);

interface UsageInfo {
  managed_mode: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  limit_reached: boolean;
}

interface Props {
  onSignInClick: () => void;
}

function UserMenuLocalOnly() {
  return (
    <div className="flex flex-col gap-3 p-4 bg-white/3 rounded-xl border border-white/8">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 text-sm flex-shrink-0">
          🦆
        </div>
        <div>
          <p className="text-sm font-medium text-white/80">Local mode</p>
          <p className="text-xs text-white/40 mt-0.5">
            All data stays on this device. Add <code className="text-[10px]">VITE_CLERK_PUBLISHABLE_KEY</code> to enable sign-in.
          </p>
        </div>
      </div>
    </div>
  );
}

function UserMenuClerk({ onSignInClick }: Props) {
  const { isSignedIn, user } = useUser();
  const { signOut } = useClerk();
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/device/usage")
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => {});
  }, []);

  if (!isSignedIn) {
    return (
      <div className="flex flex-col gap-3 p-4 bg-white/3 rounded-xl border border-white/8">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 text-sm flex-shrink-0">
            ?
          </div>
          <div>
            <p className="text-sm font-medium text-white/80">Local mode</p>
            <p className="text-xs text-white/40 mt-0.5">Sign in to enable cloud sync across devices</p>
          </div>
        </div>

        {usage?.managed_mode && usage.limit !== null && (
          <UsageMeter used={usage.used} limit={usage.limit} />
        )}

        <button
          onClick={onSignInClick}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
        >
          Sign in / Create account
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 bg-white/3 rounded-xl border border-white/8">
      <div className="flex items-center gap-3">
        <UserButton
          appearance={{
            elements: {
              avatarBox: "w-8 h-8",
              userButtonPopoverCard: "bg-[#1a1a24] border border-white/10 shadow-xl",
              userButtonPopoverActionButton: "text-white/70 hover:text-white hover:bg-white/5",
              userButtonPopoverActionButtonText: "text-white/70",
              userButtonPopoverFooter: "hidden",
            },
            variables: { colorBackground: "#1a1a24", colorText: "#ffffff" },
          }}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{user?.fullName || user?.username || "Account"}</p>
          <p className="text-xs text-white/40 truncate">{user?.primaryEmailAddress?.emailAddress}</p>
        </div>
        <PlanBadge isSignedIn={isSignedIn} />
      </div>

      {usage?.managed_mode && usage.limit !== null && (
        <UsageMeter used={usage.used} limit={usage.limit} />
      )}

      {isSignedIn && (
        <div className="text-xs text-white/30 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
          Signed in · Cloud sync coming soon
        </div>
      )}

      <button
        onClick={() => signOut()}
        className="w-full bg-white/5 hover:bg-white/8 text-white/50 text-xs py-1.5 rounded-lg transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}

export function UserMenu(props: Props) {
  if (!CLERK_ENABLED) return <UserMenuLocalOnly />;
  return <UserMenuClerk {...props} />;
}

function PlanBadge({ isSignedIn }: { isSignedIn: boolean }) {
  return (
    <span
      className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
        isSignedIn
          ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
          : "bg-white/5 text-white/30 border border-white/10"
      }`}
    >
      {isSignedIn ? "Free" : "Local"}
    </span>
  );
}

function UsageMeter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const nearLimit = pct >= 80;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[10px] text-white/40">
        <span>AI messages today</span>
        <span className={nearLimit ? "text-amber-400" : ""}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${nearLimit ? "bg-amber-400" : "bg-indigo-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {nearLimit && (
        <p className="text-[10px] text-amber-400/80">
          Add your own API key in Settings for unlimited messages
        </p>
      )}
    </div>
  );
}
