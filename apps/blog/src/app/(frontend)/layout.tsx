import type { ReactNode } from "react";

/**
 * The site's own layout.
 *
 * A separate route group from `(payload)`, because Payload's `RootLayout`
 * renders its own `<html>` and `<body>` and the two cannot share a document.
 */
export const metadata = {
  title: "Payload on Prisma",
  description: "Payload CMS running on an ordinary Prisma schema.",
};

export default function FrontendLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#0b0d10",
          color: "#e7eaee",
        }}
      >
        {children}
      </body>
    </html>
  );
}
