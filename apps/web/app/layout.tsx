import type { ReactNode } from 'react';

export const metadata = {
  title: 'Engineer Project Management OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          margin: 0,
          padding: '3rem 1.5rem',
          maxWidth: '48rem',
        }}
      >
        {children}
      </body>
    </html>
  );
}
