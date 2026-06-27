import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AppShell } from "./App";

test("renders DuckAI shell", () => {
  localStorage.setItem("sideai_onboarded", "1");
  render(<AppShell clerkEnabled={false} isClerkLoaded />);
  expect(screen.getByLabelText("DuckAI")).toBeInTheDocument();
});
