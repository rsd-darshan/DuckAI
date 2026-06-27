import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppShell } from "./App";

beforeEach(() => {
  // Panel.tsx polls /health on mount; stub it so the in-flight request
  // resolves before the test ends instead of racing jsdom teardown.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders DuckAI shell", async () => {
  localStorage.setItem("sideai_onboarded", "1");
  const { unmount } = render(<AppShell clerkEnabled={false} isClerkLoaded />);
  expect(screen.getByLabelText("DuckAI")).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  unmount();
});
