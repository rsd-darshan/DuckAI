import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sideai_theme";
type Theme = "dark" | "light";

function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (t === "dark" || t === "light") return t;
  } catch (_) {}
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {}
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  const toggle = useCallback(
    () => setThemeState((prev) => (prev === "dark" ? "light" : "dark")),
    []
  );

  return { theme, setTheme, toggle };
}
