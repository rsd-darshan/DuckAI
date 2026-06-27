/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: "var(--panel-bg)",
          "bg-elevated": "var(--panel-bg-elevated)",
          border: "var(--panel-border)",
          surface: "var(--panel-surface)",
          "surface-hover": "var(--panel-surface-hover)",
          muted: "var(--panel-muted)",
          accent: "var(--panel-accent)",
          "accent-hover": "var(--panel-accent-hover)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      spacing: {
        panel: "320px",
        strip: "48px",
      },
      borderRadius: {
        panel: "12px",
        bubble: "14px",
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(139, 92, 246, 0.25)",
        panel: "var(--panel-shadow)",
        "panel-md": "var(--panel-shadow-md)",
        "panel-lg": "var(--panel-shadow-lg)",
      },
    },
  },
  plugins: [],
};
