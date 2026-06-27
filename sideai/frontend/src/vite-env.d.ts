/// <reference types="vite/client" />
import type React from "react";

interface ImportMetaEnv {
  readonly VITE_SIDEAI_API_KEY?: string;
  /** Optional backend origin (default http://127.0.0.1:8000). No trailing slash. */
  readonly VITE_SIDEAI_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "dotlottie-wc": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        autoplay?: boolean;
        loop?: boolean;
      };
    }
  }
}

export {};
